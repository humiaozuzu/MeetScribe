// AudioWorklet：把输入（通常 48kHz、1–2 声道）混成单声道，降采样到 targetRate，
// 转成 16-bit PCM，每 chunkMs 毫秒向主线程发送一块，同时附带音量（rms/peak）。

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSize = Math.round((this.targetRate * (opts.chunkMs || 100)) / 1000);
    this.out = new Int16Array(this.chunkSize);
    this.n = 0;
    this.pos = 0;     // 距下一个输出样本还差多少输入样本
    this.acc = 0;
    this.accN = 0;
    this.sumSq = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    for (let i = 0; i < ch0.length; i++) {
      const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.acc += v;
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        // 区间平均 = 简单低通，足够语音识别使用
        let s = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.sumSq += s * s;
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
        if (this.n === this.chunkSize) this.flush();
      }
    }
    return true;
  }

  flush() {
    const buf = this.out.buffer;
    const rms = Math.sqrt(this.sumSq / this.n);
    this.port.postMessage({ pcm: buf, rms, peak: this.peak }, [buf]);
    this.out = new Int16Array(this.chunkSize);
    this.n = 0;
    this.sumSq = 0;
    this.peak = 0;
  }
}

registerProcessor('pcm-worklet', PcmProcessor);
