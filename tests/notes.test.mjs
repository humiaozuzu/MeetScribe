import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transcriptLines, notesDue, planUpdate, buildNotesPrompt, parseNotesReply, writtenIn, emptyNotes, notesEmpty,
  NOTES_INTERVAL_MS, NOTES_BATCH_LINES, NOTES_FULL_MAX_CHARS,
} from '../extension/src/lib/notes.js';
import { notesMarkdown } from '../extension/src/lib/format.js';

const seg = (id, startMs, text, extra = {}) => ({ id, startMs, endMs: startMs + 1000, text, source: 'them', speakerKey: 'them:rt1:1', speaker: 1, ...extra });

test('transcriptLines: sorted by time, labels speakers, skips empty and unsaved', () => {
  const lines = transcriptLines([
    seg(3, 5000, '第二句'),
    seg(1, 1000, 'hello', { source: 'me', speakerKey: null, speaker: undefined }),
    seg(2, 3000, '  '),
    { ...seg(null, 2000, 'unsaved') },
  ], { 'them:rt1:1': { name: 'Alice' } });
  assert.deepEqual(lines.map((l) => [l.id, l.speaker, l.text]), [[1, 'Me', 'hello'], [3, 'Alice', '第二句']]);
});

test('notesDue: first notes soon, then on the interval, never without new lines', () => {
  assert.equal(notesDue({ notes: null, newLines: 0, sinceLastMs: 1e9 }), false);
  assert.equal(notesDue({ notes: null, newLines: 3, sinceLastMs: 0 }), true);
  assert.equal(notesDue({ notes: null, newLines: 1, sinceLastMs: 5000 }), false);
  assert.equal(notesDue({ notes: null, newLines: 1, sinceLastMs: 25_000 }), true);
  const have = { summary: 'x' };
  assert.equal(notesDue({ notes: have, newLines: 50, sinceLastMs: NOTES_INTERVAL_MS - 1 }), false);
  assert.equal(notesDue({ notes: have, newLines: 1, sinceLastMs: NOTES_INTERVAL_MS }), true);
});

test('planUpdate: incremental takes lines after lastSegId by id, capped, sorted by time', () => {
  const lines = Array.from({ length: NOTES_BATCH_LINES + 5 }, (_, i) => ({ id: i + 1, startMs: (NOTES_BATCH_LINES + 5 - i) * 1000, speaker: 'Me', text: 'x' }));
  const p = planUpdate({ notes: { lastSegId: 2 }, lines, final: false });
  assert.equal(p.mode, 'incremental');
  assert.equal(p.batch.length, NOTES_BATCH_LINES);
  assert.equal(p.more, true);
  assert.ok(p.batch.every((l) => l.id > 2));
  assert.ok(p.batch[0].startMs < p.batch[1].startMs, 'sorted by time');
  assert.equal(planUpdate({ notes: { lastSegId: 999 }, lines, final: false }).batch.length, 0);
});

test('planUpdate: final rewrites from scratch unless the transcript is too long', () => {
  const short = [{ id: 1, startMs: 0, speaker: 'Me', text: 'hi' }];
  assert.equal(planUpdate({ notes: { lastSegId: 1 }, lines: short, final: true }).mode, 'full');
  const long = [{ id: 1, startMs: 0, speaker: 'Me', text: 'x'.repeat(NOTES_FULL_MAX_CHARS + 1) }];
  const p = planUpdate({ notes: { lastSegId: 1 }, lines: long, final: true });
  assert.equal(p.mode, 'incremental');
  assert.equal(p.batch.length, 0);
});

test('buildNotesPrompt: carries language, line ids and current notes only when incremental', () => {
  const batch = [{ id: 7, startMs: 65_000, speaker: 'Speaker 2', text: 'Ship on Friday' }];
  const notes = { ...emptyNotes(), summary: '已有总结', topics: [{ startMs: 0, title: '计划', summary: '', points: [{ text: 'A', t: 0 }] }] };
  const inc = buildNotesPrompt({ notes, batch, mode: 'incremental', language: 'Simplified Chinese' });
  assert.match(inc.system, /Simplified Chinese/);
  assert.match(inc.user, /L7 \[01:05\] Speaker 2: Ship on Friday/);
  assert.match(inc.user, /已有总结/);
  const full = buildNotesPrompt({ notes, batch, mode: 'full', language: 'English' });
  assert.doesNotMatch(full.user, /已有总结/);
  assert.match(full.user, /Transcript/);
});

test('parseNotesReply: maps evidence to meeting time, keeps old times, drops junk', () => {
  const lineById = new Map([[3, { id: 3, startMs: 30_000 }], [5, { id: 5, startMs: 50_000 }]]);
  const prev = { topics: [{ startMs: 1000, title: '旧话题', points: [{ text: '旧要点', t: 2000 }] }], conclusions: [], todos: [] };
  const raw = '```json\n' + JSON.stringify({
    title: '周会',
    summary: '讨论了发布计划。',
    topics: [
      { start: 'L5', title: '发布', summary: '一句话', points: [{ text: '周五发布', evidence: ['L5', 'L3', 'L99'] }] },
      { title: '旧话题', points: ['旧要点'] },
    ],
    conclusions: [{ text: '周五发布', evidence: ['L5'] }, { text: '', evidence: [] }],
    todos: [{ text: '写公告', owner: 'Me', evidence: [] }],
    terms: [{ name: 'Soniox', note: '语音识别', heard: [] }, { name: '江充', note: '人名', heard: ['江松', '江充'] }],
  }) + '\n```';
  const n = parseNotesReply(raw, { lineById, prev });
  assert.equal(n.title, '周会');
  assert.equal(n.topics[0].startMs, 50_000);
  assert.deepEqual(n.topics[0].points[0], { text: '周五发布', t: 30_000 });
  assert.equal(n.topics[1].startMs, 1000, 'topic start falls back to the previous topic with that title');
  assert.equal(n.topics[1].points[0].t, 2000, 'point without evidence keeps its old time');
  assert.deepEqual(n.conclusions, [{ text: '周五发布', t: 50_000, support: 1 }]);
  assert.deepEqual(n.todos, [{ text: '写公告', t: null, support: 0, owner: 'Me' }]);
  assert.equal(n.terms[0].name, '江充', 'misheard terms first');
  assert.deepEqual(n.terms[0].heard, ['江松'], 'heard never repeats the name');
  assert.equal(parseNotesReply('not json', { lineById, prev }), null);
  assert.equal(parseNotesReply('[1,2]', { lineById, prev }), null);
  assert.equal(parseNotesReply('{"foo": 1}', { lineById, prev }), null);
});

test('writtenIn: checks the notes language by script share', () => {
  const zh = { title: '周会', summary: '团队讨论了 Soniox 接入和发布计划，决定周五上线。', topics: [] };
  const en = { title: 'Weekly', summary: 'The team discussed the Soniox integration and agreed to ship on Friday.', topics: [] };
  const ja = { title: '定例会', summary: 'チームは Soniox の導入とリリース計画について話し、金曜日に出すことにした。', topics: [] };
  assert.equal(writtenIn(zh, 'zh'), true);
  assert.equal(writtenIn(en, 'zh'), false);
  assert.equal(writtenIn(en, 'en'), true);
  assert.equal(writtenIn(zh, 'en'), false);
  assert.equal(writtenIn(ja, 'ja'), true);
  assert.equal(writtenIn(zh, 'ja'), false, 'no kana is not Japanese');
  assert.equal(writtenIn(ja, 'zh'), false);
  assert.equal(writtenIn({ title: '', summary: 'OK', topics: [] }, 'zh'), true, 'too little text to judge');
});

test('notesMarkdown: sections with times, empty notes give nothing', () => {
  assert.equal(notesMarkdown(null), '');
  assert.equal(notesEmpty(emptyNotes()), true);
  const md = notesMarkdown({
    summary: 'S', topics: [{ startMs: 61_000, title: 'T', summary: 'one', points: [{ text: 'p', t: 62_000 }] }],
    conclusions: [{ text: 'c', t: null }], todos: [{ text: 'do', owner: 'Me', t: 0 }], terms: [{ name: 'X', note: 'n', heard: ['Y'] }],
  });
  assert.match(md, /^## Notes/);
  assert.match(md, /\*\*T\*\* \[01:01\] — one/);
  assert.match(md, /- p \[01:02\]/);
  assert.match(md, /- c$/m);
  assert.match(md, /- \[ \] \*\*Me\*\*: do \[00:00\]/);
  assert.match(md, /\*\*X\*\* — n \(heard as: Y\)/);
});
