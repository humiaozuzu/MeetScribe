// AI 会议纪要（纯逻辑，可单元测试）：转写 → 提示词，模型回复 → 纪要，以及"什么时候该更新"。
// 调用模型、读写数据库在 notes-runner.js。
//
// 思路（参考 Cicada）：会议中每隔一段时间把「当前纪要 + 新增的几行」发给模型，拿回完整的新纪要；
// 会议结束后对全文再整理一遍（final）。每条要点 / 结论 / 待办都要引用原话的行号（L + 片段 id），
// 解析时校验行号存在，换算成会议时间，界面上点一下就能跳回原话。回复解析失败或语言不对时丢弃，
// 绝不覆盖已有的纪要。
//
// 纪要结构（存在 meeting.notes）：
//   { title, summary, topics[{ startMs, title, summary, points[{ text, t }] }],
//     conclusions[{ text, t, support }], todos[{ text, owner, t, support }], terms[{ name, note, heard[] }],
//     lastSegId, lines, final, language, model, updatedAt }
// t / startMs 是会议毫秒（第一条证据的开始时间），没有证据时为 null；support 是证据行数。

import { buildSpeakerView } from './speakers.js';
import { formatClock, speakerLabel } from './format.js';

export const NOTES_LANGUAGES = { zh: 'Simplified Chinese', ja: 'Japanese', en: 'English' };

export const NOTES_FIRST_MIN_LINES = 3;
export const NOTES_FIRST_AFTER_MS = 20_000;
export const NOTES_INTERVAL_MS = 60_000;
// 一次增量更新最多带这么多新行，多出来的下一轮再发；final 时循环发完
export const NOTES_BATCH_LINES = 300;
export const NOTES_BATCH_CHARS = 40_000;
// final 整体重写时整场转写的上限，超过就改为增量补完
export const NOTES_FULL_MAX_CHARS = 150_000;

const LIMITS = { topics: 10, points: 10, conclusions: 20, todos: 20, terms: 12, text: 500 };

export function emptyNotes() {
  return { title: '', summary: '', topics: [], conclusions: [], todos: [], terms: [], lastSegId: 0, lines: 0, final: false };
}

export function notesEmpty(n) {
  return !n || (!n.summary && !n.topics?.length && !n.conclusions?.length && !n.todos?.length);
}

// 片段 → 发给模型的行（按时间排序，说话人用导出时的英文标签 / 用户起的名字）。
export function transcriptLines(segments, speakers) {
  const view = buildSpeakerView(speakers, segments);
  return segments
    .filter((s) => s.id != null && s.text?.trim())
    .map((s) => ({ id: s.id, startMs: s.startMs, speaker: speakerLabel(s, view), text: s.text.trim() }))
    .sort((a, b) => a.startMs - b.startMs || a.id - b.id);
}

export function lineText(l) {
  return `L${l.id} [${formatClock(l.startMs)}] ${l.speaker}: ${l.text}`;
}

// 会议中：新行够了、隔得够久才更新。第一次在有几行话之后尽快出。
export function notesDue({ notes, newLines, sinceLastMs }) {
  if (!newLines) return false;
  if (notesEmpty(notes)) return newLines >= NOTES_FIRST_MIN_LINES || sinceLastMs >= NOTES_FIRST_AFTER_MS;
  return sinceLastMs >= NOTES_INTERVAL_MS;
}

// 这一次发什么：final 且全文不长 → 'full'（从头写）；否则 'incremental'，只发 lastSegId 之后的一批新行。
// 片段 id 是自增的，两路音频的片段按提交顺序编号，所以用 id 而不是时间判断"新"。
export function planUpdate({ notes, lines, final }) {
  if (final) {
    const chars = lines.reduce((n, l) => n + l.text.length + 24, 0);
    if (chars <= NOTES_FULL_MAX_CHARS) return { mode: 'full', batch: lines, more: false };
  }
  const last = notes?.lastSegId || 0;
  const fresh = lines.filter((l) => l.id > last).sort((a, b) => a.id - b.id);
  const batch = [];
  let chars = 0;
  for (const l of fresh) {
    if (batch.length >= NOTES_BATCH_LINES || (batch.length && chars + l.text.length > NOTES_BATCH_CHARS)) break;
    batch.push(l);
    chars += l.text.length + 24;
  }
  batch.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
  return { mode: 'incremental', batch, more: batch.length < fresh.length };
}

// 当前纪要的精简版（给模型看，不含内部字段和证据）
function compact(n) {
  return {
    title: n.title || '',
    summary: n.summary || '',
    topics: (n.topics || []).map((tp) => ({ at: clock(tp.startMs), title: tp.title, summary: tp.summary, points: tp.points.map((p) => p.text) })),
    conclusions: (n.conclusions || []).map((c) => c.text),
    todos: (n.todos || []).map((td) => ({ text: td.text, owner: td.owner || null })),
    terms: (n.terms || []).map((tm) => ({ name: tm.name, note: tm.note, heard: tm.heard })),
  };
}

const clock = (ms) => (ms == null ? null : formatClock(ms));

export function buildNotesPrompt({ notes, batch, mode, language }) {
  const full = mode === 'full';
  const system = [
    `You keep notes for a meeting ${full ? 'from its whole transcript' : 'that is still going on, updating them as new lines arrive'}.`,
    `Write the notes in ${language}. Reply with one JSON object only.`,
  ].join(' ');
  const parts = [];
  if (!full && !notesEmpty(notes)) parts.push(`Current notes (JSON):\n${JSON.stringify(compact(notes))}`);
  parts.push([
    `${full ? 'Transcript' : 'New lines'}, one per line: id [mm:ss] speaker: text.`,
    '"Me" is the user; "Speaker N" is one person on the other side, told apart by voice and possibly wrong; "Others" is someone on the other side not told apart; any other label is a name.',
    'Speech recognition makes mistakes, often in names and jargon: correct them from context.',
    '',
    ...batch.map(lineText),
  ].join('\n'));
  parts.push([
    'Return the full updated notes as one JSON object with exactly these keys:',
    '{"title": "a short name for the meeting",',
    ' "summary": "2-4 sentences: what the meeting is about and where it stands",',
    ' "topics": [{"start": "id of the first line of the topic", "title": "short title", "summary": "one sentence",',
    '             "points": [{"text": "key point", "evidence": ["L12"]}]}],',
    ' "conclusions": [{"text": "a decision or agreed fact", "evidence": ["L7", "L8"]}],',
    ' "todos": [{"text": "an action someone committed to", "owner": "Me, a name or Speaker N from the transcript, or null when unclear", "evidence": ["L9"]}],',
    ' "terms": [{"name": "correct spelling", "note": "who or what, a few words", "heard": ["how the transcript misspelled it"]}]}',
    '',
    'Rules:',
    `- Topics in time order, at most ${LIMITS.topics - 2}. A topic is a stretch of the meeting, usually several minutes, not a single remark. Start a new topic only when the subject clearly changes${full ? '' : '; add at most one new topic per update and keep earlier topics unless new lines correct them'}.`,
    '- At most 6 points per topic. Merge repeats; keep numbers, dates and names exact.',
    '- Every point, conclusion and to-do needs evidence: the ids of the lines that say it. Never state anything the transcript does not say.',
    '- Conclusions only for things actually decided or agreed; to-dos only for actions someone committed to or was asked to do.',
    `- terms: at most ${LIMITS.terms - 2}: first names and jargon the transcript misspells (with heard), then people, products and jargon a reader would not know. name keeps the transcript's language.`,
    `- Write the title, summary, topic titles and summaries, points, conclusions and to-dos in ${language}, even when the transcript is in another language.`,
    '- Use empty arrays when there is nothing. No markdown, no text outside the JSON.',
  ].join('\n'));
  return { system, user: parts.join('\n\n') };
}

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, LIMITS.text) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

// 去掉模型偶尔包上的 ```json 围栏
function parseJson(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 模型回复 → 纪要。宽松：缺的键当空数组；证据行号对照 lineById 校验并换算成会议时间。
// 模型照抄旧条目却没给证据时，沿用旧纪要里同文字条目的时间。完全不像纪要时返回 null。
export function parseNotesReply(raw, { lineById, prev }) {
  const o = parseJson(raw);
  if (!o || (typeof o.summary !== 'string' && !Array.isArray(o.topics))) return null;
  const evidence = (ev) => {
    const ts = arr(ev, 20).map((x) => lineById.get(Number(String(x).replace(/^L/i, ''))))
      .filter(Boolean).map((l) => l.startMs);
    return { t: ts.length ? Math.min(...ts) : null, support: ts.length };
  };
  const prevTimes = new Map();
  for (const tp of prev?.topics || []) for (const p of tp.points || []) if (p.t != null) prevTimes.set(p.text, p.t);
  for (const x of [...(prev?.conclusions || []), ...(prev?.todos || [])]) if (x.t != null) prevTimes.set(x.text, x.t);
  const prevTopicStart = new Map((prev?.topics || []).map((tp) => [tp.title, tp.startMs]));
  const withTime = (text, ev) => {
    const e = evidence(ev);
    if (e.t == null && prevTimes.has(text)) e.t = prevTimes.get(text);
    return e;
  };

  const topics = arr(o.topics, LIMITS.topics).map((tp) => {
    const title = str(tp?.title);
    const points = arr(tp?.points, LIMITS.points).map((p) => {
      const text = str(typeof p === 'string' ? p : p?.text);
      return text ? { text, t: withTime(text, p?.evidence).t } : null;
    }).filter(Boolean);
    let startMs = evidence([tp?.start]).t ?? evidence(tp?.evidence).t;
    if (startMs == null) startMs = prevTopicStart.get(title) ?? null;
    if (startMs == null) {
      const ts = points.map((p) => p.t).filter((t) => t != null);
      startMs = ts.length ? Math.min(...ts) : null;
    }
    return title || points.length ? { startMs, title, summary: str(tp?.summary), points } : null;
  }).filter(Boolean);

  const items = (list, max, owner) => arr(list, max).map((x) => {
    const text = str(typeof x === 'string' ? x : x?.text);
    if (!text) return null;
    const { t, support } = withTime(text, x?.evidence);
    const item = { text, t, support };
    if (owner) item.owner = str(x?.owner) || null;
    return item;
  }).filter(Boolean);

  const terms = arr(o.terms, LIMITS.terms).map((x) => {
    const name = str(x?.name);
    if (!name) return null;
    const heard = arr(x?.heard, 6).map(str).filter((h) => h && h !== name);
    return { name, note: str(x?.note), heard };
  }).filter(Boolean);
  // 拼错过的放前面：读者自己猜不出来的最有用
  terms.sort((a, b) => (b.heard.length ? 1 : 0) - (a.heard.length ? 1 : 0));

  return {
    title: str(o.title).slice(0, 120),
    summary: str(o.summary),
    topics,
    conclusions: items(o.conclusions, LIMITS.conclusions, false),
    todos: items(o.todos, LIMITS.todos, true),
    terms,
  };
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/g;
const KANA = /[぀-ヿ]/g;
const LETTER = /[\p{L}]/gu;

// 纪要自己的文字（标题、总结、话题）是不是目标语言。长会议里模型容易被原文带跑，
// 例如英文会议写出英文纪要。人名、数字、术语可以是别的文字，所以只看比例。
export function writtenIn(notes, langCode) {
  const text = [notes.title, notes.summary, ...(notes.topics || []).flatMap((tp) => [tp.title, tp.summary])].join(' ');
  const letters = (text.match(LETTER) || []).length;
  if (letters < 12) return true;
  const cjk = (text.match(CJK) || []).length / letters;
  const kana = (text.match(KANA) || []).length / letters;
  if (langCode === 'zh') return cjk >= 0.3 && kana < 0.05;
  if (langCode === 'ja') return cjk >= 0.3 && kana >= 0.05;
  return cjk < 0.3;
}
