import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptAssembler, tokensToSegments, mergeGaps } from '../extension/src/lib/transcript.js';
import { buildMarkdown, formatClock, cleanTitle, safeFileName } from '../extension/src/lib/format.js';

const tok = (text, start, end, extra = {}) => ({ text, start_ms: start, end_ms: end, is_final: true, ...extra });

test('assembler: final tokens commit on <end> with session offset', () => {
  const segs = [];
  const partials = [];
  const a = new TranscriptAssembler({ source: 'them', onCommit: (s) => segs.push(s), onPartial: (p) => partials.push(p) });
  a.setSessionOffset(10_000);
  a.handle([tok('你好', 0, 400), { text: '世界', start_ms: 400, end_ms: 800, is_final: false }]);
  assert.equal(segs.length, 0);
  assert.deepEqual(partials.at(-1), { source: 'them', speaker: undefined, speakerKey: 'them', finalText: '你好', pendingText: '世界' });
  a.handle([tok('世界', 400, 800), tok('<end>', 800, 800)]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '你好世界');
  assert.equal(segs[0].startMs, 10_000);
  assert.equal(segs[0].endMs, 10_800);
  assert.equal(segs[0].origin, 'realtime');
});

test('assembler: speaker change splits segments', () => {
  const segs = [];
  const a = new TranscriptAssembler({ source: 'them', onCommit: (s) => segs.push(s) });
  a.handle([tok('Hi', 0, 100, { speaker: '1' }), tok(' there', 100, 200, { speaker: '1' }), tok('Hello', 300, 400, { speaker: '2' })]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'Hi there');
  assert.equal(segs[0].speaker, '1');
  a.flush();
  assert.equal(segs.length, 2);
  assert.equal(segs[1].speaker, '2');
});

test('assembler: late translation attaches to last committed segment', () => {
  const segs = [];
  const updates = [];
  const a = new TranscriptAssembler({ source: 'them', onCommit: (s) => segs.push(s), onUpdate: (s) => updates.push({ ...s }) });
  a.handle([tok('Hello', 0, 300), tok('<end>', 300, 300)]);
  a.handle([{ text: '你好', is_final: true, translation_status: 'translation' }]);
  assert.equal(segs[0].translation, '你好');
  assert.equal(updates.length, 1);
});

test('assembler: new session commits leftovers before changing offset', () => {
  const segs = [];
  const a = new TranscriptAssembler({ source: 'me', onCommit: (s) => segs.push(s) });
  a.handle([tok('半句', 0, 500)]);
  a.setSessionOffset(60_000);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].startMs, 0);
  a.handle([tok('新的', 0, 500), tok('<end>', 500, 500)]);
  assert.equal(segs[1].startMs, 60_000);
});

test('tokensToSegments: splits on pauses and filters to gaps', () => {
  const tokens = [tok('A', 0, 500), tok('B', 600, 900), tok('C', 5000, 5400), tok('D', 9000, 9300)];
  const all = tokensToSegments(tokens, { source: 'them', offsetMs: 1000 });
  assert.deepEqual(all.map((s) => s.text), ['AB', 'C', 'D']);
  assert.equal(all[0].startMs, 1000);
  const inGap = tokensToSegments(tokens, { source: 'them', offsetMs: 1000, gaps: [{ startMs: 5500, endMs: 7000 }] });
  assert.deepEqual(inGap.map((s) => s.text), ['C']);
  assert.equal(inGap[0].origin, 'async');
});

test('mergeGaps merges overlapping gaps per source', () => {
  const merged = mergeGaps([
    { source: 'them', startMs: 0, endMs: 100 },
    { source: 'me', startMs: 50, endMs: 80 },
    { source: 'them', startMs: 90, endMs: 200 },
    { source: 'them', startMs: 300, endMs: 300 },
  ]);
  assert.deepEqual(merged, [
    { source: 'me', startMs: 50, endMs: 80 },
    { source: 'them', startMs: 0, endMs: 200 },
  ]);
});

test('format helpers', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(65_000), '01:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  assert.equal(cleanTitle('Weekly sync | Microsoft Teams'), 'Weekly sync');
  assert.equal(safeFileName('a/b:c?'), 'a_b_c_');
  const md = buildMarkdown(
    { title: 'T', startedAt: 0, endedAt: 60_000, gaps: [{ source: 'them', startMs: 0, endMs: 5000 }] },
    [{ source: 'me', startMs: 1000, text: '你好' }, { source: 'them', speaker: '2', startMs: 2000, text: 'hi', translation: '嗨' }],
  );
  assert.match(md, /\*\*\[00:01\] Me\*\*: 你好/);
  // 默认编号按本场首次出现排，不用 Soniox 的原始编号
  assert.match(md, /\*\*\[00:02\] Speaker 1\*\*: hi\n> 嗨/);
  const named = buildMarkdown({ title: 'T', startedAt: 0, speakers: { 'rt:2': { name: 'Alice' } } },
    [{ source: 'them', speaker: '2', startMs: 2000, text: 'hi' }]);
  assert.match(named, /\*\*\[00:02\] Alice\*\*: hi/);
  assert.match(md, /Transcript gaps: Others 00:00–00:05/);
  assert.match(md, /^# T\n\n- Time: .*\n- Duration: 01:00\n/);
  assert.match(md, /## Transcript/);
});
