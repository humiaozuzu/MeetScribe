// 一路音频（'them' = 会议标签页 / 'me' = 麦克风）的完整处理：
//   录音支路：MediaRecorder → IndexedDB（不依赖网络，永远进行）
//   转写支路：AudioWorklet(16k PCM) → SonioxRealtime → TranscriptAssembler → IndexedDB + 广播

import { addChunk, addSegment, putSegment } from '../lib/db.js';
import { EVT, STATUS, broadcast } from '../lib/messages.js';
import { SonioxRealtime, buildRealtimeConfig, meetingTopic, SAMPLE_RATE } from '../lib/soniox-realtime.js';
import { TranscriptAssembler } from '../lib/transcript.js';

const RECORDER_TIMESLICE_MS = 5000;
const RECORDER_MIME = 'audio/webm;codecs=opus';
const LEVEL_LOG_EVERY_MS = 30_000;
const SILENCE_RMS = 0.002;
const SILENCE_WARN_MS = 60_000;
const PARTIAL_THROTTLE_MS = 150;

export class TrackPipeline {
  constructor({ source, stream, ctx, meeting, settings, log, onGap }) {
    this.source = source;
    this.stream = stream;
    this.ctx = ctx;
    this.meeting = meeting;
    this.meetingId = meeting.id;
    this.settings = settings;
    this.log = log.child({ source });
    this.onGap = onGap;
    this.status = STATUS.OFF;
    this.statusDetail = null;
    this.level = 0;
    this.muted = false;
    this.partial = null;
    this.recordInfo = { mimeType: RECORDER_MIME, chunks: 0, bytes: 0, startOffsetMs: null };
    this.totalSamples = 0;
    this.dbChain = Promise.resolve();
    this.levelStats = { sumRms: 0, n: 0, peak: 0, since: Date.now() };
    this.silentSince = Date.now();
    this.silenceWarned = false;
  }

  meetingMs() {
    return Date.now() - this.meeting.startedAt;
  }

  async start() {
    const track = this.stream.getAudioTracks()[0];
    this.log.info('track starting', {
      label: track?.label, readyState: track?.readyState, muted: track?.muted, settings: track?.getSettings?.(),
    });
    track?.addEventListener('mute', () => this.log.warn('track muted'));
    track?.addEventListener('unmute', () => this.log.info('track unmuted'));

    this._startRecorder();
    await this._startWorklet();
    this._startTranscription();
  }

  // ---------- 录音支路 ----------

  _startRecorder() {
    const mimeType = MediaRecorder.isTypeSupported(RECORDER_MIME) ? RECORDER_MIME : 'audio/webm';
    this.recordInfo.mimeType = mimeType;
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 32000 });
    } catch (e) {
      this.log.error('MediaRecorder create failed — NO local recording for this track', e);
      return;
    }
    let seq = 0;
    this.recorder.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const chunk = { meetingId: this.meetingId, source: this.source, seq: seq++, blob: ev.data, size: ev.data.size, at: this.meetingMs() };
      this.recordInfo.chunks++;
      this.recordInfo.bytes += ev.data.size;
      this.dbChain = this.dbChain
        .then(() => addChunk(chunk))
        .catch((e) => this.log.error('save audio chunk failed', { seq: chunk.seq, size: chunk.size, error: e }));
      this.log.debug('audio chunk', { seq: chunk.seq, size: chunk.size });
    };
    this.recorder.onerror = (ev) => this.log.error('MediaRecorder error', { error: ev.error });
    this.recorder.onstart = () => this.log.info('recorder started', { mimeType, state: this.recorder.state });
    this.recordInfo.startOffsetMs = this.meetingMs();
    this.recorder.start(RECORDER_TIMESLICE_MS);
  }

  _stopRecorder() {
    const r = this.recorder;
    if (!r || r.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.log.warn('recorder stop timed out'); resolve(); }, 5000);
      r.onstop = () => { clearTimeout(timer); resolve(); };
      try { r.stop(); } catch (e) { this.log.warn('recorder stop threw', e); clearTimeout(timer); resolve(); }
    });
  }

  // ---------- PCM 支路 ----------

  async _startWorklet() {
    this.srcNode = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: SAMPLE_RATE, chunkMs: 100 },
    });
    // 输出接一个静音节点到 destination，保证 worklet 一定被音频图驱动；麦克风不会被回放。
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.srcNode.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.pcmStartOffsetMs = this.meetingMs();
    this.node.port.onmessage = (ev) => this._onPcm(ev.data);
    this.log.info('pcm worklet connected', { ctxRate: this.ctx.sampleRate, ctxState: this.ctx.state, pcmStartOffsetMs: this.pcmStartOffsetMs });
  }

  _onPcm({ pcm, rms, peak }) {
    const startSample = this.totalSamples;
    this.totalSamples += pcm.byteLength / 2;
    this.level = rms;
    this._trackLevel(rms, peak);
    this.rt?.push(pcm, startSample);
  }

  _trackLevel(rms, peak) {
    const s = this.levelStats;
    s.sumRms += rms;
    s.n++;
    if (peak > s.peak) s.peak = peak;
    const now = Date.now();
    if (rms > SILENCE_RMS) {
      if (this.silenceWarned) this.log.info('audio resumed after silence', { silentMs: now - this.silentSince });
      this.silentSince = now;
      this.silenceWarned = false;
    } else if (!this.silenceWarned && now - this.silentSince > SILENCE_WARN_MS) {
      this.silenceWarned = true;
      // 开会时安静一会儿很正常，用 info：照常进导出日志，但不进扩展错误页（它收集 console.warn）
      this.log.info(this.source === 'them'
        ? 'no audio from meeting tab for 60s (meeting muted / wrong tab / nobody talking?)'
        : 'no audio from microphone for 60s (muted / wrong device?)');
    }
    if (now - s.since >= LEVEL_LOG_EVERY_MS) {
      this.log.info('audio level (30s)', {
        avgRms: +(s.sumRms / s.n).toFixed(4), peak: +s.peak.toFixed(3),
        seconds: +(this.totalSamples / SAMPLE_RATE).toFixed(1), ctxState: this.ctx.state,
      });
      this.levelStats = { sumRms: 0, n: 0, peak: 0, since: now };
    }
  }

  samplesToMeetingMs(sample) {
    return Math.round(this.pcmStartOffsetMs + (sample / SAMPLE_RATE) * 1000);
  }

  // ---------- 转写支路 ----------

  _startTranscription() {
    if (!this.settings.sonioxApiKey) {
      this._setStatus(STATUS.OFF, { reason: 'no-api-key' });
      this.log.warn('no Soniox API key — recording only');
      return;
    }
    this.assembler = new TranscriptAssembler({
      source: this.source,
      onCommit: (seg) => this._saveSegment(seg),
      onUpdate: (seg) => this._updateSegment(seg),
      onPartial: (p) => this._onPartial(p),
    });
    const config = this._rtConfig();
    this.rt = new SonioxRealtime({
      apiKey: this.settings.sonioxApiKey,
      config,
      log: this.log,
      onTokens: (tokens) => this.assembler.handle(tokens),
      onStatus: (status, detail) => this._setStatus(status, detail),
      onSessionStart: (firstSample, sessionNo) => {
        const offset = this.samplesToMeetingMs(firstSample);
        this.log.info('soniox session start', { sessionNo, firstSample, meetingOffsetMs: offset });
        this.assembler.setSessionOffset(offset, sessionNo);
      },
      onGap: (fromSample, toSample, reason) => {
        this.onGap({
          source: this.source,
          startMs: this.samplesToMeetingMs(fromSample),
          endMs: this.samplesToMeetingMs(toSample),
          reason,
        });
      },
    });
    this.rt.start();
    if (this.muted) this.rt.setPaused(true);
  }

  // 会议里的麦克风静音状态（只用于 'me'）。录音照常进行，转写暂停，见 SonioxRealtime.setPaused。
  setMuted(muted) {
    if (this.muted === muted) return;
    this.muted = muted;
    this.rt?.setPaused(muted);
  }

  setLanguages(languageHints) {
    this.settings = { ...this.settings, languageHints };
    if (!this.rt) return;
    this.rt.reconfigure(this._rtConfig());
  }

  _rtConfig() {
    return buildRealtimeConfig(this.settings, {
      diarization: this.source === 'them' && this.settings.enableDiarization,
      topic: meetingTopic(this.meeting.title),
    });
  }

  _setStatus(status, detail) {
    this.status = status;
    this.statusDetail = detail || null;
    this.log.info('transcription status', { status, detail });
    broadcast({ type: EVT.STATUS, meetingId: this.meetingId, source: this.source, status, detail: detail || null });
  }

  _saveSegment(seg) {
    const full = { ...seg, meetingId: this.meetingId };
    this.dbChain = this.dbChain.then(async () => {
      try {
        full.id = await addSegment(full);
        seg.id = full.id; // assembler.last 指向 seg，后续译文更新需要 id
        broadcast({ type: EVT.SEGMENT, meetingId: this.meetingId, segment: full });
        this.log.debug('segment saved', { id: full.id, startMs: full.startMs, len: full.text.length });
      } catch (e) {
        this.log.error('save segment failed', { error: e, text: full.text.slice(0, 50) });
      }
    });
  }

  _updateSegment(seg) {
    this.dbChain = this.dbChain.then(async () => {
      if (seg.id == null) return;
      const full = { ...seg, meetingId: this.meetingId };
      try {
        await putSegment(full);
        broadcast({ type: EVT.SEGMENT_UPDATE, meetingId: this.meetingId, segment: full });
      } catch (e) {
        this.log.error('update segment failed', e);
      }
    });
  }

  _onPartial(p) {
    this.partial = p;
    const now = Date.now();
    const empty = !p.finalText && !p.pendingText;
    if (!empty && now - (this.lastPartialAt || 0) < PARTIAL_THROTTLE_MS) {
      clearTimeout(this.partialTimer);
      this.partialTimer = setTimeout(() => this._onPartial(this.partial), PARTIAL_THROTTLE_MS);
      return;
    }
    this.lastPartialAt = now;
    broadcast({ type: EVT.PARTIAL, meetingId: this.meetingId, ...p });
  }

  // ---------- 结束 ----------

  async stop() {
    this.log.info('track stopping');
    clearTimeout(this.partialTimer);
    // 先断开 PCM 支路，停止后不再产生待转写音频
    if (this.node) this.node.port.onmessage = null;
    try { this.srcNode?.disconnect(this.node); } catch {}
    await this._stopRecorder();
    if (this.rt) {
      await this.rt.stop();
    } else if (this.totalSamples) {
      // 全程未转写（没填 key）：整段记为缺口，会后可在历史页补转
      this.onGap({ source: this.source, startMs: this.pcmStartOffsetMs, endMs: this.samplesToMeetingMs(this.totalSamples), reason: 'no-api-key' });
    }
    this.assembler?.flush();
    try { this.srcNode?.disconnect(); this.node?.disconnect(); this.mute?.disconnect(); } catch {}
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream.getTracks()) t.stop();
    await this.dbChain;
    this.log.info('track stopped', { record: this.recordInfo, seconds: +(this.totalSamples / SAMPLE_RATE).toFixed(1) });
  }

  summary() {
    return {
      ...this.recordInfo,
      pcmStartOffsetMs: this.pcmStartOffsetMs,
      seconds: +(this.totalSamples / SAMPLE_RATE).toFixed(1),
      transcription: this.status,
    };
  }
}
