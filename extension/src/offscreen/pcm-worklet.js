// AudioWorklet：把输入（通常 48kHz、1–2 声道）混成单声道，低通后降采样到 targetRate，
// 转成 16-bit PCM，每 chunkMs 毫秒向主线程发送一块，同时附带音量（rms/peak）。

import { StreamResampler } from '../lib/resampler.js';

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.resampler = new StreamResampler(sampleRate, this.targetRate);
    this.emit = (s) => this.write(s);
    this.chunkSize = Math.round((this.targetRate * (opts.chunkMs || 100)) / 1000);
    this.out = new Int16Array(this.chunkSize);
    this.n = 0;
    this.sumSq = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    for (let i = 0; i < ch0.length; i++) {
      this.resampler.push(ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i], this.emit);
    }
    return true;
  }

  write(s) {
    if (s > 1) s = 1; else if (s < -1) s = -1;
    this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.sumSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > this.peak) this.peak = a;
    if (this.n === this.chunkSize) this.flush();
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
