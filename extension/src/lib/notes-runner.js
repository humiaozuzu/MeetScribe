// 生成 / 更新一场会议的 AI 纪要：读 IndexedDB 里的片段 → 调 OpenAI → 校验 → 写回 meeting.notes。
// offscreen 会议中定时调用（live-notes.js），会后由 offscreen 做 final；历史页 / 侧边栏的"生成纪要"也走这里。
// 纯逻辑在 notes.js。

import { getMeeting, getSegments, updateMeeting } from './db.js';
import { chatJson, OpenAIError, DEFAULT_OPENAI_MODEL } from './openai.js';
import { resolveUiLang } from './i18n.js';
import { meetingTopic } from './soniox-realtime.js';
import {
  NOTES_LANGUAGES, emptyNotes, transcriptLines, planUpdate, buildNotesPrompt, parseNotesReply, writtenIn,
} from './notes.js';

export function notesLanguageCode(settings, browserLangs = globalThis.navigator?.languages) {
  return NOTES_LANGUAGES[settings.notesLanguage] ? settings.notesLanguage : resolveUiLang(settings.uiLanguage, browserLangs);
}

// 一次模型调用；回复不像纪要或语言不对时重试一次，再不行就报错（旧纪要保持不变）。
async function callModel({ settings, prompt, prev, lineById, langCode, log, fetchImpl }) {
  const model = settings.openaiModel || DEFAULT_OPENAI_MODEL;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const res = await chatJson({ apiKey: settings.openaiApiKey, model, ...prompt, fetchImpl });
    const parsed = parseNotesReply(res.content, { lineById, prev });
    const info = { attempt, model: res.model, ms: Date.now() - started, finishReason: res.finishReason, usage: res.usage, replyChars: res.content.length };
    if (!parsed) {
      log.warn('notes reply not usable JSON, dropped', info);
      if (res.finishReason === 'length') throw new OpenAIError('notes reply was cut off (max tokens)', { code: 'length' });
      continue;
    }
    if (!writtenIn(parsed, langCode)) {
      log.warn('notes reply not in the notes language, dropped', { ...info, language: langCode });
      continue;
    }
    log.info('notes model reply', { ...info, topics: parsed.topics.length, conclusions: parsed.conclusions.length, todos: parsed.todos.length, terms: parsed.terms.length });
    return { parsed, model: res.model };
  }
  throw new OpenAIError('notes reply unusable after retry', { code: 'bad-reply' });
}

// final=false：带上 lastSegId 之后的一批新行做一次增量更新（没有新行就什么都不做）。
// final=true：全文不长就从头重写，否则增量补完剩下的行；最后标记 final。
// 返回 { notes, changed }。出错时抛 OpenAIError（kind 见 openai.js）。
export async function updateNotes({ meetingId, settings, final = false, log, fetchImpl }) {
  if (!settings.openaiApiKey) throw new OpenAIError('no OpenAI API key', { code: 'no-key' });
  const [meeting, segs] = await Promise.all([getMeeting(meetingId), getSegments(meetingId)]);
  if (!meeting) throw new Error(`meeting ${meetingId} not found`);
  const lines = transcriptLines(segs, meeting.speakers);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const langCode = notesLanguageCode(settings);
  const language = NOTES_LANGUAGES[langCode];
  // 纪要语言改了：旧纪要不再作为基础，从头写
  let notes = meeting.notes?.language === langCode ? meeting.notes : emptyNotes();
  let changed = false;

  for (;;) {
    const plan = planUpdate({ notes, lines, final });
    if (plan.mode === 'full') notes = emptyNotes();
    if (!plan.batch.length) break;
    log.info('notes update', {
      mode: plan.mode, final, lines: plan.batch.length, total: lines.length, more: plan.more,
      chars: plan.batch.reduce((n, l) => n + l.text.length, 0), language: langCode,
    });
    const prompt = buildNotesPrompt({ notes, batch: plan.batch, mode: plan.mode, language });
    const { parsed, model } = await callModel({ settings, prompt, prev: notes, lineById, langCode, log, fetchImpl });
    notes = {
      ...parsed,
      title: parsed.title || notes.title,
      lastSegId: Math.max(notes.lastSegId || 0, ...plan.batch.map((l) => l.id)),
      lines: plan.mode === 'full' ? plan.batch.length : (notes.lines || 0) + plan.batch.length,
      final: false,
      language: langCode,
      model,
      updatedAt: Date.now(),
    };
    changed = true;
    if (!final || !plan.more) break;
  }

  if (final && lines.length) {
    notes = { ...notes, final: true, updatedAt: notes.updatedAt || Date.now() };
    changed = true;
  }
  if (!changed) return { notes: meeting.notes || null, changed: false };

  const saved = notes;
  await updateMeeting(meetingId, (m) => {
    m.notes = saved;
    // 标题只是 Meet 会议码 / 默认值时，用纪要起的名字
    if (final && saved.title && !meetingTopic(m.title)) m.title = saved.title;
  });
  return { notes: saved, changed: true };
}

// 错误 → 界面状态（notes.state.*）
export function notesErrorState(e) {
  if (e?.code === 'no-key') return 'no-key';
  if (e instanceof OpenAIError) {
    const k = e.kind;
    return ['invalid-key', 'no-quota', 'rate-limited', 'model'].includes(k) ? k : 'failed';
  }
  return 'failed';
}
