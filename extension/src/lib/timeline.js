// 会议时间轴相关的纯计算（可单元测试）。

// 录音文件的 0 秒在会议时间轴上的位置，用"最后一块录音数据的时刻 − 文件时长"反推。
// 旧版本按调用 MediaRecorder.start() 的时刻记 startOffsetMs，麦克风起播慢时会早好几秒；
// 回放时拿到真实时长后用这个校正。差得不多（< toleranceMs）时信任记录值，返回 null。
// 只往后校正：录音只会比调用 start() 晚开始，不会更早。
export function correctedStartOffset({ startOffsetMs, lastChunkAtMs, durationMs, toleranceMs = 1000 }) {
  if (![startOffsetMs, lastChunkAtMs, durationMs].every(Number.isFinite) || durationMs <= 0) return null;
  const derived = Math.round(lastChunkAtMs - durationMs);
  return derived - startOffsetMs > toleranceMs ? derived : null;
}
