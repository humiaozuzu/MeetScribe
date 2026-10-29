// Soniox 实时转写 WebSocket 客户端（一路音频一个实例）。
//
// 设计要点（见 docs/architecture.md「Real-time client」）：
//   - key 通过 WebSocket 子协议 ['soniox-api-key', KEY] 传递，不放进配置 JSON。
//   - 断线自动重连（指数退避），重连期间最多缓存最近 BUFFER_MS 的音频，连上后补发；
//     没能发出去的音频通过 onGap(startSample, endSample) 报给调用方，记为"转写缺口"，会后补转。
//   - key 无效 / 欠费等不可恢复错误 → FAILED，不再重连（录音不受影响）。
//   - 单流 300 分钟上限：到 ROTATE_AFTER_MS 主动换新连接。
//   - 长时间没发音频时发 keepalive。
//   - 会议里麦克风静音 → setPaused(true)：Soniox 按流的时长计费（不是按音频），所以静音
//     超过 PAUSE_CLOSE_AFTER_MS 就关闭连接，取消静音再重连。宽限期内发静音帧代替真实音频，
//     时间轴保持连续，短暂开关麦不必重连。静音期间的音频不转写，也不算缺口。
//
// 采样位置：push(buf, startSample) 带上该块首个样本在整条音轨中的序号（16kHz），
// onSessionStart(firstSample) 让调用方把 token 的会话内时间换算到会议时间轴。

import { STATUS } from './messages.js';

export const SONIOX_RT_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const SONIOX_RT_MODEL = 'stt-rt-v5';
export const SAMPLE_RATE = 16000;

const BUFFER_MS = 10_000;
const KEEPALIVE_IDLE_MS = 10_000;
const ROTATE_AFTER_MS = 290 * 60_000;
const STOP_TIMEOUT_MS = 8_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const STATS_EVERY_MS = 60_000;
const PAUSE_CLOSE_AFTER_MS = 10_000;

// 这些错误重连也没用。
const FATAL_CODES = new Set([400, 401, 402, 403]);

export function buildRealtimeConfig(settings, { diarization } = {}) {
  const cfg = {
    model: SONIOX_RT_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: SAMPLE_RATE,
    num_channels: 1,
    enable_endpoint_detection: true,
    max_endpoint_delay_ms: settings.maxEndpointDelayMs || 500,
  };
  if (diarization) cfg.enable_speaker_diarization = true;
  if (settings.languageHints?.length) cfg.language_hints = settings.languageHints;
  if (settings.contextTerms?.length) cfg.context = { terms: settings.contextTerms };
  if (settings.translationTarget) cfg.translation = { type: 'one_way', target_language: settings.translationTarget };
  return cfg;
}

export class SonioxRealtime {
  constructor({ apiKey, config, log, onTokens, onStatus, onSessionStart, onGap }) {
    this.apiKey = apiKey;
    this.config = config;
    this.log = log;
    this.onTokens = onTokens || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onSessionStart = onSessionStart || (() => {});
    this.onGap = onGap || (() => {});

    this.ws = null;
    this.status = STATUS.CLOSED;
    this.live = false;          // 已发送配置、可推音频
    this.stopping = false;
    this.rotating = false;
    this.paused = false;        // 会议中静音：不转写真实音频
    this.pauseClosed = false;   // 静音超过宽限期，连接已关闭（或正在关闭）
    this.resumeAfterClose = false; // 关闭途中取消了静音：关闭后立即重连
    this.fatal = null;
    this.attempt = 0;
    this.pending = [];          // 未发送的 { buf, startSample, samples }
    this.pendingSamples = 0;
    this.sentUpTo = 0;          // 已发送音频的结束样本（之前的都已交给 Soniox）
    this.totalPushed = 0;       // 收到的音频结束样本
    this.sessionNo = 0;
    this.timers = {};
    this.stats = { bytes: 0, chunks: 0, responses: 0, finalTokens: 0, dropped: 0 };
    this.lastSendAt = 0;
  }

  _setStatus(status, detail) {
    if (this.status === status && !detail) return;
    this.status = status;
    this.onStatus(status, detail);
  }

  start() {
    this.stopping = false;
    this.timers.keepalive = setInterval(() => this._keepalive(), 5000);
    this.timers.stats = setInterval(() => this._logStats(), STATS_EVERY_MS);
    this._connect();
  }

  _connect() {
    clearTimeout(this.timers.reconnect);
    if (this.stopping || this.pauseClosed) return;
    const sessionNo = ++this.sessionNo;
    this._setStatus(this.attempt ? STATUS.RECONNECTING : STATUS.CONNECTING);
    this.log.info('soniox connecting', { sessionNo, attempt: this.attempt, config: this.config });
    let ws;
    try {
      ws = new WebSocket(SONIOX_RT_URL, ['soniox-api-key', this.apiKey]);
    } catch (e) {
      this.log.error('soniox WebSocket constructor failed', e);
      this._scheduleReconnect('constructor-error');
      return;
    }
    this.ws = ws;
    const openedAt = Date.now();
    let gotFirstToken = false;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.log.info('soniox ws open', { sessionNo, protocol: ws.protocol, ms: Date.now() - openedAt });
      ws.send(JSON.stringify(this.config));
      this.live = true;
      this.sessionStartedAt = Date.now();
      const firstSample = this.pending.length ? this.pending[0].startSample : this.totalPushed;
      if (firstSample > this.sentUpTo) {
        this.log.warn('soniox transcription gap (audio not sent)', {
          fromSample: this.sentUpTo, toSample: firstSample,
          gapMs: Math.round(((firstSample - this.sentUpTo) / SAMPLE_RATE) * 1000),
        });
        this.onGap(this.sentUpTo, firstSample, 'disconnected');
      }
      this.sentUpTo = firstSample;
      this.onSessionStart(firstSample, sessionNo);
      const backlogMs = Math.round((this.pendingSamples / SAMPLE_RATE) * 1000);
      if (backlogMs) this.log.info('soniox flushing buffered audio', { backlogMs });
      this._flushPending();
      clearTimeout(this.timers.rotate);
      this.timers.rotate = setTimeout(() => this._rotate(), ROTATE_AFTER_MS);
      this._setStatus(this.paused ? STATUS.PAUSED : STATUS.LIVE);
      // attempt 在收到第一个正常响应后才归零，避免"连上即被拒"时快速重连刷屏
    };

    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        this.log.warn('soniox non-JSON message', { data: String(ev.data).slice(0, 200) });
        return;
      }
      if (msg.error_code != null || msg.error_message) {
        const code = Number(msg.error_code);
        const fatal = FATAL_CODES.has(code);
        this.lastError = { code, type: msg.error_type, message: msg.error_message };
        this.log.error('soniox error message', { sessionNo, ...this.lastError, requestId: msg.request_id, fatal });
        if (fatal) this.fatal = this.lastError;
        return; // 服务端随后关闭连接，在 onclose 统一处理
      }
      this.attempt = 0;
      this.stats.responses++;
      if (msg.tokens?.length) {
        if (!gotFirstToken) {
          gotFirstToken = true;
          this.log.info('soniox first tokens', { sessionNo, msSinceOpen: Date.now() - openedAt });
        }
        for (const t of msg.tokens) if (t.is_final) this.stats.finalTokens++;
        try {
          this.onTokens(msg.tokens);
        } catch (e) {
          this.log.error('onTokens handler threw', e);
        }
      }
      if (msg.finished) {
        this.log.info('soniox finished', { sessionNo, finalAudioMs: msg.final_audio_proc_ms, totalAudioMs: msg.total_audio_proc_ms });
      }
    };

    ws.onerror = () => {
      if (ws !== this.ws) return;
      // 浏览器不暴露具体原因，细节看随后的 onclose code
      this.log.warn('soniox ws error event', { sessionNo, readyState: ws.readyState });
    };

    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      const wasLive = this.live;
      this.live = false;
      this.ws = null;
      clearTimeout(this.timers.rotate);
      const info = {
        sessionNo, code: ev.code, reason: ev.reason, wasClean: ev.wasClean, wasLive,
        livedMs: wasLive && this.sessionStartedAt ? Date.now() - this.sessionStartedAt : 0,
      };
      if (this.stopping) {
        this.log.info('soniox closed (stopping)', info);
        this._resolveStop?.();
        return;
      }
      if (this.fatal) {
        this.log.error('soniox closed with fatal error, giving up — recording continues', { ...info, error: this.fatal });
        this._dropPending();
        this._setStatus(STATUS.FAILED, this.fatal);
        return;
      }
      if (this.pauseClosed) {
        this.log.info('soniox closed (mic muted)', info);
        return;
      }
      if (this.resumeAfterClose) {
        this.resumeAfterClose = false;
        this.log.info('soniox closed while unmuting, reconnecting now', info);
        this._connect();
        return;
      }
      if (this.rotating) {
        this.rotating = false;
        this.log.info('soniox rotated session closed, reconnecting now', info);
        this._connect();
        return;
      }
      this.log.warn('soniox closed unexpectedly', { ...info, lastError: this.lastError });
      this._scheduleReconnect(`close ${ev.code}`);
    };
  }

  _scheduleReconnect(reason) {
    if (this.stopping || this.fatal) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this._setStatus(STATUS.RECONNECTING, { reason, delayMs: delay, attempt: this.attempt });
    this.log.info('soniox reconnect scheduled', { reason, delayMs: delay, attempt: this.attempt });
    this.timers.reconnect = setTimeout(() => this._connect(), delay);
  }

  // 会议中改配置（例如语言）：Soniox 不支持连接中途修改，换一条新连接。
  // 期间音频进缓存，新连接建立后补发，不产生缺口。
  reconfigure(config) {
    this.config = config;
    if (this.stopping || this.fatal) return false;
    this.log.info('soniox reconfigure', { config, live: this.live });
    if (this.live) this._rotate('reconfigure');
    // 正在连接 / 等待重连：下一次 onopen 自动使用新配置
    return true;
  }

  setPaused(paused) {
    paused = !!paused;
    if (paused === this.paused) return;
    this.paused = paused;
    if (this.stopping || this.fatal) return;
    clearTimeout(this.timers.pauseClose);
    if (paused) {
      this.pausedAtSample = this.totalPushed;
      this.log.info('soniox paused (mic muted)', { live: this.live, closeAfterMs: PAUSE_CLOSE_AFTER_MS });
      this.timers.pauseClose = setTimeout(() => this._closeForPause(), PAUSE_CLOSE_AFTER_MS);
      this._setStatus(STATUS.PAUSED);
      return;
    }
    this.log.info('soniox resumed (mic unmuted)', { pauseClosed: this.pauseClosed, live: this.live });
    if (!this.pauseClosed) {
      this._setStatus(this.live ? STATUS.LIVE : this.attempt ? STATUS.RECONNECTING : STATUS.CONNECTING);
      return;
    }
    this.pauseClosed = false;
    if (this.ws) {
      this.resumeAfterClose = true; // 旧连接还在收尾，onclose 后重连
      return;
    }
    this.attempt = 0;
    this._connect();
  }

  _closeForPause() {
    if (!this.paused || this.stopping || this.fatal) return;
    this.pauseClosed = true;
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.rotate);
    // 静音前还没送出去的音频（断线缓存里的）已无法实时转写，记为缺口
    if (this.pausedAtSample > this.sentUpTo) {
      this.log.warn('soniox transcription gap (audio not sent before mute)', { fromSample: this.sentUpTo, toSample: this.pausedAtSample });
      this.onGap(this.sentUpTo, this.pausedAtSample, 'disconnected');
    }
    this._dropPending();
    this.sentUpTo = this.totalPushed;
    const ws = this.ws;
    this.log.info('soniox closing session while muted (stream time is billed)', { live: this.live, hasWs: !!ws });
    if (this.live && ws?.readyState === WebSocket.OPEN) {
      this.live = false;
      try { ws.send(''); } catch (e) { this.log.warn('pause send end failed', e); }
    } else if (ws) {
      this.live = false;
      this.ws = null; // 还没连上：直接丢弃，onclose 不再处理
      try { ws.close(); } catch {}
    }
  }

  _rotate(reason = 'approaching 300 min limit') {
    if (!this.live || this.stopping) return;
    this.log.info('soniox rotating session', { reason });
    this.rotating = true;
    this.live = false; // 之后的音频先进缓存，等新连接
    try { this.ws.send(''); } catch (e) { this.log.warn('rotate send end failed', e); }
  }

  push(buf, startSample) {
    // 停止后到达的音频不属于这场会议的转写范围，不计入，否则会被误报成"缺口"
    if (this.stopping) return;
    const samples = buf.byteLength / 2;
    this.totalPushed = startSample + samples;
    if (this.fatal) return;
    if (this.pauseClosed) {
      this.sentUpTo = this.totalPushed; // 静音中且连接已关：不转写，也不算缺口
      return;
    }
    if (this.paused) buf = new ArrayBuffer(buf.byteLength); // 宽限期：发静音帧
    if (this.live && this.ws?.readyState === WebSocket.OPEN) {
      this._send(buf, startSample + samples);
      return;
    }
    // 未连通：缓存最近 BUFFER_MS
    this.pending.push({ buf, startSample, samples });
    this.pendingSamples += samples;
    const max = (BUFFER_MS / 1000) * SAMPLE_RATE;
    while (this.pendingSamples > max) {
      const old = this.pending.shift();
      this.pendingSamples -= old.samples;
      this.stats.dropped += old.samples;
    }
  }

  _flushPending() {
    for (const p of this.pending) this._send(p.buf, p.startSample + p.samples);
    this._dropPending();
  }

  _dropPending() {
    this.pending = [];
    this.pendingSamples = 0;
  }

  _send(buf, endSample) {
    try {
      this.ws.send(buf);
      this.sentUpTo = endSample;
      this.stats.bytes += buf.byteLength;
      this.stats.chunks++;
      this.lastSendAt = Date.now();
    } catch (e) {
      this.log.warn('soniox send failed', e);
    }
  }

  _keepalive() {
    if (!this.live || this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastSendAt < KEEPALIVE_IDLE_MS) return;
    try {
      this.ws.send(JSON.stringify({ type: 'keepalive' }));
      this.lastSendAt = Date.now();
      this.log.debug('soniox keepalive sent');
    } catch (e) {
      this.log.warn('keepalive failed', e);
    }
  }

  _logStats() {
    this.log.info('soniox stats (since last report)', {
      status: this.status,
      kbSent: Math.round(this.stats.bytes / 1024),
      chunks: this.stats.chunks,
      responses: this.stats.responses,
      finalTokens: this.stats.finalTokens,
      droppedMs: Math.round((this.stats.dropped / SAMPLE_RATE) * 1000),
      bufferedMs: Math.round((this.pendingSamples / SAMPLE_RATE) * 1000),
    });
    this.stats = { bytes: 0, chunks: 0, responses: 0, finalTokens: 0, dropped: 0 };
  }

  // 优雅结束：发送空文本帧，等服务端返回剩余结果并关闭。
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of Object.values(this.timers)) { clearTimeout(t); clearInterval(t); }
    this._logStats();
    const ws = this.ws;
    if (ws) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn('soniox stop timed out, force closing');
          try { ws.close(); } catch {}
          resolve();
        }, STOP_TIMEOUT_MS);
        this._resolveStop = () => { clearTimeout(timer); resolve(); };
        try {
          if (ws.readyState === WebSocket.OPEN && this.live) ws.send('');
          else ws.close();
        } catch (e) {
          this.log.warn('soniox stop send failed', e);
          this._resolveStop();
        }
      });
    }
    this.live = false;
    if (this.totalPushed > this.sentUpTo) {
      this.log.warn('soniox stopped with untranscribed tail', {
        fromSample: this.sentUpTo, toSample: this.totalPushed, reason: this.fatal ? 'fatal' : 'disconnected',
      });
      this.onGap(this.sentUpTo, this.totalPushed, this.fatal ? 'fatal' : 'disconnected');
    }
    this._setStatus(STATUS.CLOSED);
  }
}
