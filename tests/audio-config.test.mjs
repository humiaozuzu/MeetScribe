import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamResampler } from '../extension/src/lib/resampler.js';
import { migrateSettings, DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';
import { buildRealtimeConfig, meetingTopic } from '../extension/src/lib/soniox-realtime.js';
import { buildAsyncConfig, meetingLanguageHints } from '../extension/src/lib/soniox-async.js';

// 把 seconds 秒、freq Hz 的正弦波送进重采样器，返回输出样本。
function resampleSine(inRate, outRate, freq, seconds = 1) {
  const r = new StreamResampler(inRate, outRate);
  const out = [];
  const emit = (v) => out.push(v);
  for (let i = 0; i < inRate * seconds; i++) r.push(Math.sin((2 * Math.PI * freq * i) / inRate), emit);
  return out;
}

// 跳过滤波器启动段后的峰值幅度。
const amplitude = (xs) => Math.max(...xs.slice(200).map(Math.abs));

test('resampler: output length follows the rate ratio', () => {
  assert.equal(resampleSine(48000, 16000, 440).length, 16000);
  assert.ok(Math.abs(resampleSine(44100, 16000, 440).length - 16000) <= 1);
  assert.equal(resampleSine(16000, 16000, 440).length, 16000, 'same rate is a passthrough');
});

test('resampler: speech band passes, content above 8 kHz is removed (no aliasing)', () => {
  for (const inRate of [48000, 44100]) {
    assert.ok(Math.abs(amplitude(resampleSine(inRate, 16000, 1000)) - 1) < 0.02, `1 kHz kept at ${inRate}`);
    assert.ok(amplitude(resampleSine(inRate, 16000, 3400)) > 0.97, `3.4 kHz kept at ${inRate}`);
    assert.ok(amplitude(resampleSine(inRate, 16000, 12000)) < 0.01, `12 kHz removed at ${inRate}`);
  }
});

test('resampler: same-rate passthrough keeps samples exactly', () => {
  const r = new StreamResampler(16000, 16000);
  const out = [];
  for (const v of [0.1, -0.2, 0.3]) r.push(v, (x) => out.push(x));
  assert.deepEqual(out.map((x) => +x.toFixed(6)), [0.1, -0.2, 0.3]);
});

test('settings: v1 endpoint default 500 migrates to 1000, user value kept', () => {
  assert.equal(migrateSettings({ maxEndpointDelayMs: 500 }).maxEndpointDelayMs, 1000);
  assert.equal(migrateSettings({ maxEndpointDelayMs: 800 }).maxEndpointDelayMs, 800);
  assert.equal(migrateSettings({ maxEndpointDelayMs: 500, settingsVersion: 2 }).maxEndpointDelayMs, 500, 'chosen after v2: kept');
  assert.equal(migrateSettings({}).settingsVersion, 2);
  assert.equal(DEFAULT_SETTINGS.maxEndpointDelayMs, 1000);
  assert.equal(DEFAULT_SETTINGS.micNoiseSuppression, false);
});

test('meetingTopic ignores meeting codes and default titles', () => {
  assert.equal(meetingTopic('Meet abc-defg-hij'), null);
  assert.equal(meetingTopic('会议'), null);
  assert.equal(meetingTopic(''), null);
  assert.equal(meetingTopic('Q3 规划评审'), 'Q3 规划评审');
});

test('context: topic goes into general, terms kept', () => {
  const cfg = buildRealtimeConfig({ contextTerms: ['Soniox'] }, { topic: 'Q3 规划评审' });
  assert.deepEqual(cfg.context, { general: [{ key: 'topic', value: 'Q3 规划评审' }], terms: ['Soniox'] });
  assert.equal(cfg.max_endpoint_delay_ms, 1000, 'default endpoint delay');
  assert.equal(buildRealtimeConfig({}).context, undefined);
  assert.deepEqual(buildAsyncConfig({ languageHints: ['en'] }, { topic: 'X' }).context, { general: [{ key: 'topic', value: 'X' }] });
});

test('retranscribe uses the languages the meeting actually used', () => {
  const meeting = { transcription: { languageHints: ['ja'], languageChanges: [{ atMs: 1, from: ['zh', 'en'], languageHints: ['ja'] }] } };
  assert.deepEqual(meetingLanguageHints(meeting, ['ko']), ['zh', 'en', 'ja']);
  assert.deepEqual(meetingLanguageHints({}, ['ko']), ['ko'], 'old meetings fall back to settings');
  assert.deepEqual(buildAsyncConfig({ languageHints: ['ko'] }, { languageHints: ['zh'] }).language_hints, ['zh']);
});
