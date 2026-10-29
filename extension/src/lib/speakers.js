// 说话人表（纯逻辑，可单元测试）。
//
// Soniox 的说话人编号只在一次转写会话内有效：实时流重连 / 轮换 / 改语言后从 1 重排，
// 每次异步转写也是一套新编号。所以片段只存"说话人键" speakerKey，键里带上会话标签：
//   rt3:1   实时第 3 个 WebSocket 会话里的说话人 1
//   a<run>:1 / g<run>:1  某次整场重转 / 补转缺口里的说话人 1
//   them    没开说话人区分的"对方"整体
// "我"那一路没有键。
//
// 名字和合并关系存在会议记录上，片段不改：
//   meeting.speakers = { [key]: { name } | { alias: otherKey } }
// alias 表示"和 otherKey 是同一个人"（合并）。顺着 alias 走到头的键叫规范键，名字挂在规范键上。

export function speakerKeyFor(source, tag, speaker) {
  if (source === 'me') return null;
  if (speaker == null || speaker === '') return 'them';
  return `${tag}:${speaker}`;
}

// 旧数据（加说话人表之前录的）没有 speakerKey，按原来的编号推一个。
export function segmentKey(seg) {
  if (seg.source === 'me') return null;
  if (seg.speakerKey) return seg.speakerKey;
  return speakerKeyFor(seg.source, seg.origin === 'async' ? 'a' : 'rt', seg.speaker);
}

export function canonicalKey(speakers, key) {
  let k = key;
  const seen = new Set();
  while (k && speakers?.[k]?.alias && !seen.has(k)) {
    seen.add(k);
    k = speakers[k].alias;
  }
  return k;
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// 汇总一场会议出现过的说话人（按首次出现排序），供界面显示和改名下拉框。
// 返回 { list: [{ key, name, n, keys, ms }], byKey: Map<任意键, 条目>, nextN }
//   nextN：下一个新出现的说话人会拿到的编号（侧边栏实时行还没定稿时用）。
//   n：默认编号（未命名时显示"对方 n"），按规范键首次出现的顺序分配，命名后编号也不变，
//      这样改了一个人的名字，其他人的编号不会跟着挪。'them'（没区分说话人）没有编号。
export function buildSpeakerView(speakers, segments) {
  const list = [];
  const byCanon = new Map();
  const byKey = new Map();
  let n = 0;
  for (const seg of segments || []) {
    const key = segmentKey(seg);
    if (!key) continue;
    let entry = byKey.get(key);
    if (!entry) {
      const canon = canonicalKey(speakers, key);
      entry = byCanon.get(canon);
      if (!entry) {
        entry = { key: canon, name: speakers?.[canon]?.name || '', n: canon === 'them' ? null : ++n, keys: [], ms: 0 };
        byCanon.set(canon, entry);
        list.push(entry);
      }
      entry.keys.push(key);
      byKey.set(key, entry);
    }
    entry.ms += Math.max(0, (seg.endMs ?? seg.startMs) - seg.startMs);
  }
  return { list, byKey, nextN: n + 1 };
}

// 改名。名字和本场另一个人相同 → 合并到那个人（学 Notta：同一个入口既能改名也能合并）。
// 空名字 = 清除名字，恢复默认编号。返回新的 speakers 对象和 { merged: 目标规范键 | null }。
export function renameSpeaker(speakers, key, name, view) {
  const next = { ...(speakers || {}) };
  const canon = canonicalKey(next, key);
  const trimmed = (name || '').trim();
  if (!trimmed) {
    delete next[canon];
    return { speakers: next, merged: null };
  }
  const target = view?.list.find((e) => e.key !== canon && e.name && sameName(e.name, trimmed));
  if (target) return { speakers: mergeSpeaker(next, canon, target.key), merged: target.key };
  next[canon] = { name: trimmed };
  return { speakers: next, merged: null };
}

// 把 fromKey 这个人并入 intoKey。from 已有名字、into 没有时，名字带过去。
export function mergeSpeaker(speakers, fromKey, intoKey) {
  const next = { ...(speakers || {}) };
  const from = canonicalKey(next, fromKey);
  const into = canonicalKey(next, intoKey);
  if (!from || !into || from === into) return next;
  const fromName = next[from]?.name;
  if (fromName && !next[into]?.name) next[into] = { name: fromName };
  next[from] = { alias: into };
  return next;
}

// 只保留还被片段用到的键（以及它们 alias 链上的键），整场重转后清掉旧会话的条目。
export function pruneSpeakers(speakers, segments) {
  const keep = new Set();
  for (const seg of segments || []) {
    let k = segmentKey(seg);
    while (k && !keep.has(k)) {
      keep.add(k);
      k = speakers?.[k]?.alias;
    }
  }
  const next = {};
  for (const [k, v] of Object.entries(speakers || {})) if (keep.has(k)) next[k] = v;
  return next;
}

const overlapMs = (a, b) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

// 整场重转后按时间重叠继承名字。
// 对每个新说话人键，统计它和旧片段里各个"已命名的人"在时间上重叠了多少；
// 只在双方互为最佳匹配、且重叠占新说话人发言时长 ≥ minShare 时才继承。
// 互为最佳是为了不把两个人并成一个：比如旧的是没区分说话人的"对方 = 张三"，
// 新结果分出了 a:1、a:2，只有和"张三"重叠最多的那一个继承名字，另一个保持未命名。
// 不会自动合并新说话人；返回要写入的条目和统计（用于日志）。
export function inheritSpeakerNames({ speakers, oldSegments, newSegments, minShare = 0.3 }) {
  const named = [];
  for (const seg of oldSegments || []) {
    const key = segmentKey(seg);
    if (!key) continue;
    const canon = canonicalKey(speakers, key);
    const name = speakers?.[canon]?.name;
    if (name) named.push({ canon, name, startMs: seg.startMs, endMs: seg.endMs ?? seg.startMs });
  }
  const total = new Map();      // 新键 -> 发言时长
  const overlap = new Map();    // 新键 -> Map<旧规范键, 重叠 ms>
  for (const seg of newSegments || []) {
    const key = segmentKey(seg);
    if (!key) continue;
    const end = seg.endMs ?? seg.startMs;
    total.set(key, (total.get(key) || 0) + Math.max(0, end - seg.startMs));
    for (const old of named) {
      const ms = overlapMs({ startMs: seg.startMs, endMs: end }, old);
      if (!ms) continue;
      if (!overlap.has(key)) overlap.set(key, new Map());
      const m = overlap.get(key);
      m.set(old.canon, (m.get(old.canon) || 0) + ms);
    }
  }
  const best = (pairs) => pairs.reduce((a, b) => (b[1] > a[1] ? b : a), [null, 0]);
  const bestOld = new Map();    // 新键 -> [旧规范键, ms]
  for (const [key, m] of overlap) bestOld.set(key, best([...m]));
  const bestNew = new Map();    // 旧规范键 -> [新键, ms]
  for (const [key, m] of overlap) {
    for (const [canon, ms] of m) {
      if (ms > (bestNew.get(canon)?.[1] || 0)) bestNew.set(canon, [key, ms]);
    }
  }
  const nameOf = new Map(named.map((x) => [x.canon, x.name]));
  const entries = {};
  const matches = [];
  for (const [key, [canon, ms]] of bestOld) {
    if (!canon || bestNew.get(canon)?.[0] !== key) continue;
    const share = total.get(key) ? ms / total.get(key) : 0;
    if (share < minShare) continue;
    entries[key] = { name: nameOf.get(canon) };
    matches.push({ key, from: canon, share: +share.toFixed(2) });
  }
  return { entries, matches, newSpeakers: total.size };
}
