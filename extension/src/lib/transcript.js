// 把 Soniox 返回的 token 拼成字幕片段（纯逻辑，无浏览器依赖，可单元测试）。
//
// Soniox 实时语义：
//   - is_final=true 的 token 只发一次，永不改变；非 final 的 token 每次响应整体替换。
//   - 开启 endpoint 检测后，一句话结束时会收到 final 的 "<end>"；手动 finalize 后收到 "<fin>"。
//   - translation_status === 'translation' 的 token 是译文，没有时间戳。
// 时间：token 的 start_ms/end_ms 相对本次 WebSocket 会话的音频起点；
//       sessionOffsetMs 是该起点在整场会议时间轴上的位置。
// 说话人：编号只在一次会话内有效，片段的 speakerKey 带上会话标签（见 speakers.js）。

import { speakerKeyFor } from './speakers.js';

const CONTROL_TOKENS = new Set(['<end>', '<fin>']);

export class TranscriptAssembler {
  constructor({ source, onCommit, onPartial, onUpdate }) {
    this.source = source;
    this.onCommit = onCommit || (() => {});
    this.onPartial = onPartial || (() => {});
    this.onUpdate = onUpdate || (() => {});
    this.sessionOffsetMs = 0;
    this.sessionTag = 'rt';
    this.cur = [];          // 已 final 但尚未断句的 token
    this.curTranslation = '';
    this.last = null;       // 最近提交的片段（用于挂接迟到的译文）
  }

  setSessionOffset(ms, sessionNo) {
    // 新会话开始前，把上一会话残留的 final token 先提交掉。
    this.commit();
    this.sessionOffsetMs = ms;
    this.sessionTag = sessionNo == null ? 'rt' : `rt${sessionNo}`;
  }

  handle(tokens) {
    const pending = [];
    for (const t of tokens || []) {
      if (t.translation_status === 'translation') {
        if (t.is_final) this._addTranslation(t.text);
        continue;
      }
      if (CONTROL_TOKENS.has(t.text)) {
        if (t.is_final) this.commit();
        continue;
      }
      if (t.is_final) {
        const head = this.cur[0];
        if (head && t.speaker != null && head.speaker != null && t.speaker !== head.speaker) this.commit();
        this.cur.push({
          text: t.text,
          startMs: (t.start_ms ?? 0) + this.sessionOffsetMs,
          endMs: (t.end_ms ?? t.start_ms ?? 0) + this.sessionOffsetMs,
          speaker: t.speaker,
          language: t.language,
        });
      } else {
        pending.push(t);
      }
    }
    const speaker = this.cur[0]?.speaker ?? pending[0]?.speaker;
    this.onPartial({
      source: this.source,
      speaker,
      speakerKey: speakerKeyFor(this.source, this.sessionTag, speaker),
      finalText: joinText(this.cur),
      pendingText: joinText(pending),
    });
  }

  _addTranslation(text) {
    if (this.cur.length || !this.last) {
      this.curTranslation += text;
    } else {
      this.last.translation = ((this.last.translation || '') + text);
      this.onUpdate(this.last);
    }
  }

  commit() {
    if (!this.cur.length) return null;
    const seg = buildSegment(this.cur, this.source, 'realtime', this.sessionTag);
    if (this.curTranslation.trim()) seg.translation = this.curTranslation.trim();
    this.cur = [];
    this.curTranslation = '';
    if (!seg.text) return null;
    this.last = seg;
    this.onCommit(seg);
    return seg;
  }

  flush() {
    const seg = this.commit();
    this.onPartial({ source: this.source, speaker: undefined, finalText: '', pendingText: '' });
    return seg;
  }
}

function joinText(tokens) {
  return tokens.map((t) => t.text).join('').trim();
}

function buildSegment(tokens, source, origin, tag) {
  return {
    source,
    speaker: tokens[0].speaker,
    speakerKey: speakerKeyFor(source, tag, tokens[0].speaker),
    language: tokens.find((t) => t.language)?.language,
    startMs: tokens[0].startMs,
    endMs: tokens[tokens.length - 1].endMs,
    text: joinText(tokens),
    origin,
  };
}

const SENTENCE_END = /[。！？!?.]\s*$/;

// 异步（整文件）转写结果 → 片段。按说话人变化、长停顿、长句断开。
// opts.gaps: 只保留落在这些区间内的 token（补转缺口用），区间为会议时间轴毫秒。
// opts.tag: 说话人键的会话标签，每次异步转写一个（编号只在这一次结果里有效）。
export function tokensToSegments(tokens, { source, offsetMs = 0, origin = 'async', gaps = null, tag = 'a',
  pauseMs = 1500, maxSegmentMs = 15000 } = {}) {
  const segs = [];
  let cur = [];
  const push = () => {
    if (cur.length) {
      const seg = buildSegment(cur, source, origin, tag);
      if (seg.text) segs.push(seg);
    }
    cur = [];
  };
  for (const t of tokens || []) {
    if (t.translation_status === 'translation' || CONTROL_TOKENS.has(t.text)) continue;
    const tok = {
      text: t.text,
      startMs: t.start_ms + offsetMs,
      endMs: t.end_ms + offsetMs,
      speaker: t.speaker,
      language: t.language,
    };
    if (gaps) {
      const mid = (tok.startMs + tok.endMs) / 2;
      if (!gaps.some((g) => mid >= g.startMs && mid < g.endMs)) { push(); continue; }
    }
    const prev = cur[cur.length - 1];
    if (prev) {
      const speakerChanged = tok.speaker != null && prev.speaker != null && tok.speaker !== prev.speaker;
      const longPause = tok.startMs - prev.endMs > pauseMs;
      const tooLong = prev.endMs - cur[0].startMs > maxSegmentMs && SENTENCE_END.test(prev.text);
      if (speakerChanged || longPause || tooLong) push();
    }
    cur.push(tok);
  }
  push();
  return segs;
}

// 合并相邻/重叠的缺口区间。
export function mergeGaps(gaps) {
  const sorted = [...gaps].filter((g) => g.endMs > g.startMs)
    .sort((a, b) => (a.source || '').localeCompare(b.source || '') || a.startMs - b.startMs);
  const out = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && last.source === g.source && g.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, g.endMs);
    } else {
      out.push({ ...g });
    }
  }
  return out;
}
