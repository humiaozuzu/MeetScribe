// 悬浮字幕要显示什么（纯逻辑，可单元测试）。offscreen 用它把实时行 / 刚定稿的片段整理成几行，
// 经 SW 转发给会议页面里的 content/captions.js。
//
// 每路音频（them / me）最多一行：正在说的话（partial）优先，否则是最近定稿的片段（含译文）。
// 定稿片段 CAPTION_KEEP_MS 内没有新动静就不再显示，没人说话时字幕条自动收起。

export const CAPTION_KEEP_MS = 8000;

export class CaptionState {
  constructor() {
    this.src = {}; // source → { live: { text, pending } | null, last: { startMs, text, translation } | null, at }
  }

  _s(source) {
    return (this.src[source] ||= { live: null, last: null, at: 0 });
  }

  partial(source, p, now) {
    const s = this._s(source);
    if (p?.finalText || p?.pendingText) {
      s.live = { text: p.finalText || '', pending: p.pendingText || '' };
      s.at = now;
    } else {
      s.live = null;
    }
  }

  commit(source, seg, now) {
    const s = this._s(source);
    s.last = { startMs: seg.startMs, text: seg.text || '', translation: seg.translation || '' };
    s.live = null;
    s.at = now;
  }

  // 迟到的译文挂到刚定稿的片段上
  update(source, seg, now) {
    const s = this._s(source);
    if (!s.last || s.last.startMs !== seg.startMs) return;
    s.last.translation = seg.translation || '';
    s.at = now;
  }

  // 按最近动静排序，最新的在下面
  rows(now) {
    const out = [];
    for (const [source, s] of Object.entries(this.src)) {
      if (s.live) out.push({ source, text: s.live.text, pending: s.live.pending, translation: '', at: s.at });
      else if (s.last && now - s.at < CAPTION_KEEP_MS) out.push({ source, text: s.last.text, pending: '', translation: s.last.translation, at: s.at });
    }
    return out.sort((a, b) => a.at - b.at).map(({ at, ...r }) => r);
  }
}
