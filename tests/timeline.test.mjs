import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctedStartOffset } from '../extension/src/lib/timeline.js';

test('recording start offset is corrected when the recorder started late', () => {
  // 实测：iPhone 连续互通麦克风，start() 在 168 ms，真正开录在约 2.9 s，文件 53.34 s，最后一块在 56.25 s
  assert.equal(correctedStartOffset({ startOffsetMs: 168, lastChunkAtMs: 56_250, durationMs: 53_340 }), 2910);
});

test('recording start offset is kept when it already matches', () => {
  assert.equal(correctedStartOffset({ startOffsetMs: 11, lastChunkAtMs: 56_220, durationMs: 56_140 }), null);
  // 推算值更早（时长测量误差）也不改
  assert.equal(correctedStartOffset({ startOffsetMs: 3000, lastChunkAtMs: 50_000, durationMs: 49_000 }), null);
});

test('recording start offset ignores missing or unknown durations', () => {
  assert.equal(correctedStartOffset({ startOffsetMs: 0, lastChunkAtMs: 10_000, durationMs: Infinity }), null);
  assert.equal(correctedStartOffset({ startOffsetMs: 0, lastChunkAtMs: undefined, durationMs: 5000 }), null);
  assert.equal(correctedStartOffset({ startOffsetMs: 0, lastChunkAtMs: 10_000, durationMs: NaN }), null);
});
