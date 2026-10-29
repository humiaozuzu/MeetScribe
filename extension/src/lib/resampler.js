// 流式降采样（纯逻辑，AudioWorklet 和单元测试共用）。
// 先用加窗 sinc 低通（截止 CUTOFF_HZ）滤掉目标采样率奈奎斯特频率以上的成分，避免混叠；
// 再在相邻两个滤波后样本之间线性插值，支持 44.1k → 16k 这类非整数比例。
// 输入采样率不高于目标时不滤波，只插值。

const CUTOFF_HZ = 7200;       // 16k 的奈奎斯特是 8k，留出过渡带
const TAPS_PER_RATIO = 16;    // 滤波器长度 ≈ 16 × 比例（48k→16k 为 49 阶）

function lowpassTaps(inRate, cutoffHz, n) {
  const fc = cutoffHz / inRate; // 归一化截止频率（周期/样本）
  const m = (n - 1) / 2;
  const h = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)); // Blackman
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum; // 直流增益 = 1
  return h;
}

export class StreamResampler {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    const n = this.ratio > 1 ? 2 * Math.ceil((TAPS_PER_RATIO * this.ratio) / 2) + 1 : 1;
    this.taps = n > 1 ? lowpassTaps(inRate, Math.min(CUTOFF_HZ, outRate * 0.45), n) : Float32Array.of(1);
    this.hist = new Float32Array(n * 2); // 双写环形缓冲：hist[w..w+n) 始终是最近 n 个样本
    this.w = 0;
    this.prev = 0;  // 上一个滤波后样本
    this.t = 0;     // 下一个输出点相对当前输入样本的位置（输入样本为单位，≤0 表示该输出了）
  }

  // 处理一个输入样本，每产生一个输出样本调用一次 emit(value)。
  push(v, emit) {
    const n = this.taps.length;
    let y = v;
    if (n > 1) {
      this.w = (this.w + n - 1) % n;
      this.hist[this.w] = v;
      this.hist[this.w + n] = v;
      y = 0;
      const h = this.taps, b = this.hist, w = this.w;
      for (let k = 0; k < n; k++) y += h[k] * b[w + k];
    }
    while (this.t <= 0) {
      emit(this.prev + (y - this.prev) * (1 + this.t));
      this.t += this.ratio;
    }
    this.t -= 1;
    this.prev = y;
  }
}
