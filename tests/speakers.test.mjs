import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speakerKeyFor, segmentKey, canonicalKey, buildSpeakerView, renameSpeaker, mergeSpeaker,
  pruneSpeakers, inheritSpeakerNames,
} from '../extension/src/lib/speakers.js';
import { TranscriptAssembler, tokensToSegments } from '../extension/src/lib/transcript.js';

const seg = (speakerKey, startMs, endMs, extra = {}) => ({ source: 'them', speakerKey, startMs, endMs, text: 'x', ...extra });

test('speaker keys carry the session tag; me has none; no diarization is "them"', () => {
  assert.equal(speakerKeyFor('them', 'rt2', '1'), 'rt2:1');
  assert.equal(speakerKeyFor('them', 'rt2', undefined), 'them');
  assert.equal(speakerKeyFor('me', 'rt2', '1'), null);
  // 旧数据没有 speakerKey
  assert.equal(segmentKey({ source: 'them', speaker: '3', origin: 'realtime' }), 'rt:3');
  assert.equal(segmentKey({ source: 'them', speaker: '3', origin: 'async' }), 'a:3');
  assert.equal(segmentKey({ source: 'them' }), 'them');
});

test('assembler and async segments get keys per session', () => {
  const segs = [];
  const a = new TranscriptAssembler({ source: 'them', onCommit: (s) => segs.push(s) });
  a.setSessionOffset(0, 1);
  a.handle([{ text: 'A', start_ms: 0, end_ms: 100, is_final: true, speaker: '1' }, { text: '<end>', is_final: true }]);
  a.setSessionOffset(60_000, 2);
  a.handle([{ text: 'B', start_ms: 0, end_ms: 100, is_final: true, speaker: '1' }, { text: '<end>', is_final: true }]);
  assert.deepEqual(segs.map((s) => s.speakerKey), ['rt1:1', 'rt2:1']);
  const asyncSegs = tokensToSegments([{ text: 'C', start_ms: 0, end_ms: 100, speaker: '2' }], { source: 'them', tag: 'ax' });
  assert.equal(asyncSegs[0].speakerKey, 'ax:2');
});

test('view numbers people by first appearance and keeps numbers after renaming', () => {
  const segs = [seg('rt1:2', 0, 1000), seg('rt1:1', 1000, 3000), seg('rt2:1', 5000, 6000), seg('rt1:2', 7000, 8000)];
  let view = buildSpeakerView({}, segs);
  assert.deepEqual(view.list.map((e) => [e.key, e.n, e.ms]), [['rt1:2', 1, 2000], ['rt1:1', 2, 2000], ['rt2:1', 3, 1000]]);
  assert.equal(view.nextN, 4);
  const { speakers } = renameSpeaker({}, 'rt1:2', '  Alice ', view);
  view = buildSpeakerView(speakers, segs);
  assert.equal(view.byKey.get('rt1:2').name, 'Alice');
  assert.equal(view.byKey.get('rt1:1').n, 2);
});

test('renaming to an existing name merges; merge carries the name; clearing restores default', () => {
  const segs = [seg('rt1:1', 0, 1000), seg('rt2:1', 5000, 6000), seg('rt2:2', 7000, 8000)];
  let speakers = { 'rt1:1': { name: 'Alice' } };
  let view = buildSpeakerView(speakers, segs);
  const res = renameSpeaker(speakers, 'rt2:1', 'alice', view);
  assert.equal(res.merged, 'rt1:1');
  speakers = res.speakers;
  assert.equal(canonicalKey(speakers, 'rt2:1'), 'rt1:1');
  view = buildSpeakerView(speakers, segs);
  assert.equal(view.list.length, 2);
  assert.deepEqual(view.byKey.get('rt2:1').keys, ['rt1:1', 'rt2:1']);
  // 改合并后的人的名字，两段一起变
  speakers = renameSpeaker(speakers, 'rt2:1', 'Alice Wang', view).speakers;
  assert.equal(buildSpeakerView(speakers, segs).byKey.get('rt1:1').name, 'Alice Wang');
  // 未命名的人并入未命名的人 / 已命名的并入未命名的：名字带过去
  speakers = mergeSpeaker({ 'rt2:2': { name: 'Bob' } }, 'rt2:2', 'rt1:1');
  assert.deepEqual(speakers, { 'rt1:1': { name: 'Bob' }, 'rt2:2': { alias: 'rt1:1' } });
  // 自己并入自己、alias 环都不会死循环
  assert.deepEqual(mergeSpeaker(speakers, 'rt2:2', 'rt1:1'), speakers);
  assert.equal(canonicalKey({ a: { alias: 'b' }, b: { alias: 'a' } }, 'a'), 'a');
  const cleared = renameSpeaker({ 'rt1:1': { name: 'Bob' } }, 'rt1:1', ' ', view).speakers;
  assert.deepEqual(cleared, {});
});

test('prune keeps used keys and their alias targets', () => {
  const speakers = { 'rt1:1': { name: 'A' }, 'rt2:1': { alias: 'rt1:1' }, 'rt9:1': { name: 'gone' } };
  assert.deepEqual(pruneSpeakers(speakers, [seg('rt2:1', 0, 1)]), { 'rt1:1': { name: 'A' }, 'rt2:1': { alias: 'rt1:1' } });
});

test('inherit names after full retranscription by time overlap', () => {
  const speakers = { 'rt1:1': { name: 'Alice' }, 'rt1:2': { name: 'Bob' }, 'rt2:1': { alias: 'rt1:1' } };
  const oldSegments = [seg('rt1:1', 0, 4000), seg('rt1:2', 4000, 8000), seg('rt2:1', 10_000, 14_000), seg('rt2:2', 14_000, 16_000)];
  const newSegments = [seg('ax:1', 200, 3800), seg('ax:2', 4100, 7900), seg('ax:1', 10_000, 13_900), seg('ax:3', 14_000, 16_000)];
  const res = inheritSpeakerNames({ speakers, oldSegments, newSegments });
  assert.deepEqual(res.entries, { 'ax:1': { name: 'Alice' }, 'ax:2': { name: 'Bob' } });
  assert.equal(res.newSpeakers, 3);
});

test('inherit never gives one name to two new speakers', () => {
  // 实时没开说话人区分："对方"被命名为张三；重转分出了两个人
  const speakers = { them: { name: '张三' } };
  const oldSegments = [seg('them', 0, 10_000)];
  const newSegments = [seg('ax:1', 0, 7000), seg('ax:2', 7000, 10_000)];
  const res = inheritSpeakerNames({ speakers, oldSegments, newSegments });
  assert.deepEqual(res.entries, { 'ax:1': { name: '张三' } });
});

test('inherit skips weak overlaps', () => {
  const speakers = { 'rt1:1': { name: 'Alice' } };
  const res = inheritSpeakerNames({ speakers, oldSegments: [seg('rt1:1', 0, 1000)], newSegments: [seg('ax:1', 800, 10_000)] });
  assert.deepEqual(res.entries, {});
});
