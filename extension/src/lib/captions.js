// 悬浮字幕要显示什么（纯逻辑，可单元测试）。offscreen 用它把实时行 / 刚定稿的片段整理成几行，
// 经 SW 转发给会议页面里的 content/captions.js。
//
// 每路音频（them / me）最多一行。参考 Cicada：原文是「上一句定稿 + 正在说的话」拼在一起，译文是最近几句的
// 译文拼在一起；字幕条只保留结尾两行（content/captions.js），所以下一句开口时上一句不会一下子消失，
// 而是随着新字慢慢被挤出去。上一句太久以前（CAPTION_JOIN_MS）就不再拼。
// 定稿片段 CAPTION_KEEP_MS 内没有新动静就不再显示，没人说话时字幕条自动收起。

export const CAPTION_KEEP_MS = 8000;
export const CAPTION_JOIN_MS = 20_000;
const RECENT = 3;

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// 中日文之间不加空格，其余用空格
export function joinText(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return CJK.test(a.at(-1)) || CJK.test(b[0]) ? a + b : `${a} ${b}`;
}

export class CaptionState {
  constructor() {
    // source → { live: { text, pending } | null, recent: [{ startMs, text, translation, at }]（旧 → 新）, at }
    this.src = {};
  }

  _s(source) {
    return (this.src[source] ||= { live: null, recent: [], at: 0 });
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
    s.recent.push({ startMs: seg.startMs, text: seg.text || '', translation: seg.translation || '', at: now });
    if (s.recent.length > RECENT) s.recent.shift();
    s.live = null;
    s.at = now;
  }

  // 迟到的译文挂到对应的定稿片段上
  update(source, seg, now) {
    const s = this._s(source);
    const hit = s.recent.find((r) => r.startMs === seg.startMs);
    if (!hit) return;
    hit.translation = seg.translation || '';
    s.at = now;
  }

  // 按最近动静排序，最新的在下面
  rows(now) {
    const out = [];
    for (const [source, s] of Object.entries(this.src)) {
      const recent = s.recent.filter((r) => now - r.at < CAPTION_JOIN_MS);
      const last = recent.at(-1);
      const translation = recent.map((r) => r.translation).filter(Boolean).reduce(joinText, '');
      if (s.live) {
        out.push({ source, text: joinText(last?.text || '', s.live.text), pending: s.live.pending, translation, at: s.at });
      } else if (last && now - s.at < CAPTION_KEEP_MS) {
        out.push({ source, text: last.text, pending: '', translation, at: s.at });
      }
    }
    return out.sort((a, b) => a.at - b.at).map(({ at, ...r }) => r);
  }
}
