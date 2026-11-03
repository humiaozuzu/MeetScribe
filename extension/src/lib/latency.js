// 延迟统计（纯逻辑，可单元测试）：攒一段时间的样本，定期输出 p50 / p95 / max 到日志。
// 只记数字，不记文本。用于排查"字幕慢""译文慢"。

export class LatencyStats {
  constructor(max = 2000) {
    this.max = max; // 一个统计周期最多保留的样本数，防止异常情况下无限增长
    this.samples = [];
  }

  add(ms) {
    if (!Number.isFinite(ms)) return;
    if (this.samples.length >= this.max) this.samples.shift();
    this.samples.push(Math.max(0, Math.round(ms)));
  }

  get count() {
    return this.samples.length;
  }

  // 没有样本时返回 null，日志里就不出现这一项
  summary() {
    const n = this.samples.length;
    if (!n) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    return { n, p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: s[n - 1] };
  }

  reset() {
    this.samples = [];
  }
}

// s 已升序。最近秩法：p95 取第 ceil(0.95n) 个。
export function percentile(s, p) {
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
