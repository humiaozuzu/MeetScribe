import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SonioxRealtime, buildRealtimeConfig } from '../extension/src/lib/soniox-realtime.js';

// 最小 WebSocket 替身：记录发送内容，由测试手动触发 open/message/close。
class FakeWS {
  static OPEN = 1;
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this._close(1000); }
  _open() { this.readyState = 1; this.onopen?.(); }
  _msg(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  _close(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '', wasClean: code === 1000 }); }
}
globalThis.WebSocket = FakeWS;

const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return quietLog; } };
const pcm = (samples) => new Int16Array(samples).buffer;

function makeRt(extra = {}) {
  const gaps = [];
  const sessions = [];
  const statuses = [];
  const tokens = [];
  const rt = new SonioxRealtime({
    apiKey: 'k', config: { model: 'stt-rt-v5' }, log: quietLog,
    onGap: (a, b, r) => gaps.push([a, b, r]),
    onSessionStart: (s) => sessions.push(s),
    onStatus: (s) => statuses.push(s),
    onTokens: (t) => tokens.push(...t),
    ...extra,
  });
  return { rt, gaps, sessions, statuses, tokens };
}

test('config: key goes in subprotocol, not in config JSON', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt } = makeRt();
  rt.start();
  const ws = FakeWS.instances[0];
  assert.deepEqual(ws.protocols, ['soniox-api-key', 'k']);
  ws._open();
  const cfg = JSON.parse(ws.sent[0]);
  assert.equal(cfg.api_key, undefined);
  rt.stop();
  mock.timers.reset();
});

test('audio before connect is buffered and flushed; no gap', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, sessions } = makeRt();
  rt.start();
  rt.push(pcm(1600), 0);
  rt.push(pcm(1600), 1600);
  const ws = FakeWS.instances[0];
  ws._open();
  assert.deepEqual(sessions, [0]);
  assert.equal(ws.sent.length, 3); // config + 2 chunks
  assert.equal(gaps.length, 0);
  rt.stop();
  mock.timers.reset();
});

test('disconnect longer than buffer records a gap and reconnects', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, sessions, statuses } = makeRt();
  rt.start();
  FakeWS.instances[0]._open();
  rt.push(pcm(1600), 0);               // 已发送 0..1600
  FakeWS.instances[0]._close(1006);    // 断线
  assert.ok(statuses.includes('reconnecting'));
  // 断线期间推 15 秒音频（缓存上限 10 秒）
  for (let i = 0; i < 150; i++) rt.push(pcm(1600), 1600 + i * 1600);
  mock.timers.tick(1000);              // 退避 1s 后重连
  assert.equal(FakeWS.instances.length, 2);
  FakeWS.instances[1]._open();
  // 最早保留的块从 1600 + 50*1600 开始 → 缺口 [1600, 81600)
  assert.deepEqual(gaps, [[1600, 81600, 'disconnected']]);
  assert.deepEqual(sessions, [0, 81600]);
  rt.stop();
  mock.timers.reset();
});

test('fatal error stops reconnecting and reports tail gap on stop', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, statuses } = makeRt();
  rt.start();
  const ws = FakeWS.instances[0];
  ws._open();
  rt.push(pcm(1600), 0);
  ws._msg({ error_code: 401, error_type: 'unauthenticated', error_message: 'bad key' });
  ws._close(1000);
  assert.ok(statuses.includes('failed'));
  rt.push(pcm(1600), 1600);
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 1, 'no reconnect after fatal error');
  await rt.stop();
  assert.deepEqual(gaps, [[1600, 3200, 'fatal']]);
  mock.timers.reset();
});

test('tokens are passed through and graceful stop sends empty frame', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, tokens } = makeRt();
  rt.start();
  const ws = FakeWS.instances[0];
  ws._open();
  ws._msg({ tokens: [{ text: 'hi', is_final: true }] });
  assert.equal(tokens.length, 1);
  const p = rt.stop();
  assert.equal(ws.sent.at(-1), '');
  ws._close(1000);
  await p;
  mock.timers.reset();
});

test('audio arriving while stopping is not reported as a gap', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps } = makeRt();
  rt.start();
  const ws = FakeWS.instances[0];
  ws._open();
  rt.push(pcm(1600), 0);
  const p = rt.stop();
  rt.push(pcm(1600), 1600); // 等服务端返回结果期间 worklet 仍在产出
  ws._close(1000);
  await p;
  assert.deepEqual(gaps, []);
  mock.timers.reset();
});

test('reconfigure mid-session reconnects with new config without a gap', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, sessions } = makeRt();
  rt.start();
  const ws1 = FakeWS.instances[0];
  ws1._open();
  rt.push(pcm(1600), 0);
  rt.reconfigure({ model: 'stt-rt-v5', language_hints: ['ko'] });
  assert.equal(ws1.sent.at(-1), '', 'old session asked to finish');
  rt.push(pcm(1600), 1600);          // 切换期间的音频进缓存
  ws1._close(1000);
  assert.equal(FakeWS.instances.length, 2, 'reconnects immediately');
  const ws2 = FakeWS.instances[1];
  ws2._open();
  assert.deepEqual(JSON.parse(ws2.sent[0]).language_hints, ['ko']);
  assert.equal(ws2.sent.length, 2, 'buffered audio flushed');
  assert.deepEqual(sessions, [0, 1600]);
  assert.deepEqual(gaps, []);
  rt.stop();
  mock.timers.reset();
});

test('pause: grace period sends silence, then closes the stream; no gap', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, statuses } = makeRt();
  rt.start();
  const ws1 = FakeWS.instances[0];
  ws1._open();
  const speech = new Int16Array(1600).fill(1000).buffer;
  rt.setPaused(true);
  assert.equal(statuses.at(-1), 'paused');
  rt.push(speech, 0);
  assert.ok(new Int16Array(ws1.sent.at(-1)).every((v) => v === 0), 'muted audio replaced by silence');
  mock.timers.tick(10_000);
  assert.equal(ws1.sent.at(-1), '', 'stream asked to finish after grace period');
  ws1._close(1000);
  assert.equal(FakeWS.instances.length, 1, 'no reconnect while muted');
  rt.push(speech, 1600);
  assert.equal(ws1.sent.filter((d) => d instanceof ArrayBuffer).length, 1, 'nothing sent while closed');
  rt.stop();
  assert.deepEqual(gaps, [], 'muted audio is not a transcription gap');
  mock.timers.reset();
});

test('unmute after close reconnects with a new session at the right sample', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, gaps, sessions } = makeRt();
  rt.start();
  FakeWS.instances[0]._open();
  rt.setPaused(true);
  mock.timers.tick(10_000);
  FakeWS.instances[0]._close(1000);
  rt.push(pcm(1600), 0);             // 静音中
  rt.setPaused(false);
  assert.equal(FakeWS.instances.length, 2, 'reconnects on unmute');
  rt.push(pcm(1600), 1600);          // 连接中，进缓存
  const ws2 = FakeWS.instances[1];
  ws2._open();
  assert.deepEqual(sessions, [0, 1600]);
  assert.equal(ws2.sent.length, 2, 'config + buffered audio');
  assert.deepEqual(gaps, []);
  rt.stop();
  mock.timers.reset();
});

test('unmute while the paused stream is still closing reconnects after close', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt } = makeRt();
  rt.start();
  FakeWS.instances[0]._open();
  rt.setPaused(true);
  mock.timers.tick(10_000);
  rt.setPaused(false);
  assert.equal(FakeWS.instances.length, 1, 'waits for old stream to close');
  FakeWS.instances[0]._close(1000);
  assert.equal(FakeWS.instances.length, 2, 'reconnects right after close');
  rt.stop();
  mock.timers.reset();
});

test('short mute within grace period keeps the same session', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  FakeWS.instances = [];
  const { rt, statuses } = makeRt();
  rt.start();
  FakeWS.instances[0]._open();
  rt.setPaused(true);
  mock.timers.tick(3000);
  rt.setPaused(false);
  mock.timers.tick(20_000);
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(statuses.at(-1), 'live');
  const speech = new Int16Array(1600).fill(1000).buffer;
  rt.push(speech, 0);
  assert.equal(FakeWS.instances[0].sent.at(-1), speech, 'real audio sent again');
  rt.stop();
  mock.timers.reset();
});

test('buildRealtimeConfig maps settings', () => {
  const cfg = buildRealtimeConfig({ languageHints: ['zh'], contextTerms: ['Soniox'], translationTarget: 'en', maxEndpointDelayMs: 700 }, { diarization: true });
  assert.equal(cfg.audio_format, 'pcm_s16le');
  assert.equal(cfg.sample_rate, 16000);
  assert.equal(cfg.enable_speaker_diarization, true);
  assert.deepEqual(cfg.context, { terms: ['Soniox'] });
  assert.deepEqual(cfg.translation, { type: 'one_way', target_language: 'en' });
  assert.equal(cfg.max_endpoint_delay_ms, 700);
});
