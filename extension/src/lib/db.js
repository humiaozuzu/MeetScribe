// IndexedDB 封装。所有扩展上下文（SW、offscreen、页面）共享同一个库。
//   meetings: { id, title, url, startedAt, endedAt, status, tracks, gaps, jobs, ... }
//   segments: { id, meetingId, source: 'me'|'them', speaker, startMs, endMs, text, translation, origin }
//   chunks:   { id, meetingId, source, seq, blob, size, at }
//   logs:     { id, ts, level, ctx, msg, data, meetingId }

const DB_NAME = 'meetscribe';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meetings')) {
        const s = db.createObjectStore('meetings', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains('segments')) {
        const s = db.createObjectStore('segments', { keyPath: 'id', autoIncrement: true });
        s.createIndex('meetingId', 'meetingId');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        s.createIndex('meetingId', 'meetingId');
      }
      if (!db.objectStoreNames.contains('logs')) {
        const s = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('[db] open blocked by another connection');
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

// ---------- meetings ----------

export function putMeeting(meeting) {
  return tx('meetings', 'readwrite', (t) => reqToPromise(t.objectStore('meetings').put(meeting)));
}

export function getMeeting(id) {
  return tx('meetings', 'readonly', (t) => reqToPromise(t.objectStore('meetings').get(id)));
}

// 读-改-写，同一事务内完成，避免并发覆盖。
export function updateMeeting(id, mutate) {
  return tx('meetings', 'readwrite', async (t) => {
    const store = t.objectStore('meetings');
    const m = await reqToPromise(store.get(id));
    if (!m) throw new Error(`meeting ${id} not found`);
    const next = mutate(m) || m;
    await reqToPromise(store.put(next));
    return next;
  });
}

export async function listMeetings() {
  const all = await tx('meetings', 'readonly', (t) => reqToPromise(t.objectStore('meetings').getAll()));
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteMeeting(id) {
  return tx(['meetings', 'segments', 'chunks'], 'readwrite', async (t) => {
    t.objectStore('meetings').delete(id);
    for (const name of ['segments', 'chunks']) {
      const keys = await reqToPromise(t.objectStore(name).index('meetingId').getAllKeys(id));
      for (const k of keys) t.objectStore(name).delete(k);
    }
  });
}

// ---------- segments ----------

export function addSegment(seg) {
  return tx('segments', 'readwrite', (t) => reqToPromise(t.objectStore('segments').add(seg)));
}

export function putSegment(seg) {
  return tx('segments', 'readwrite', (t) => reqToPromise(t.objectStore('segments').put(seg)));
}

export async function getSegments(meetingId) {
  const segs = await tx('segments', 'readonly', (t) =>
    reqToPromise(t.objectStore('segments').index('meetingId').getAll(meetingId)));
  return segs.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
}

// 用新的一批片段替换某个来源的片段（整场重转）或追加（补转缺口）。
export function replaceSegments(meetingId, source, newSegs, { onlyOrigin } = {}) {
  return tx('segments', 'readwrite', async (t) => {
    const store = t.objectStore('segments');
    const existing = await reqToPromise(store.index('meetingId').getAll(meetingId));
    for (const s of existing) {
      if (s.source !== source) continue;
      if (onlyOrigin && s.origin !== onlyOrigin) continue;
      store.delete(s.id);
    }
    for (const s of newSegs) store.add(s);
  });
}

export function addSegments(segs) {
  return tx('segments', 'readwrite', (t) => {
    const store = t.objectStore('segments');
    for (const s of segs) store.add(s);
  });
}

// ---------- audio chunks ----------

export function addChunk(chunk) {
  return tx('chunks', 'readwrite', (t) => reqToPromise(t.objectStore('chunks').add(chunk)));
}

export async function getChunks(meetingId, source) {
  const all = await tx('chunks', 'readonly', (t) =>
    reqToPromise(t.objectStore('chunks').index('meetingId').getAll(meetingId)));
  return all.filter((c) => !source || c.source === source).sort((a, b) => a.seq - b.seq);
}

// ---------- logs ----------

export function addLogs(entries) {
  return tx('logs', 'readwrite', (t) => {
    const store = t.objectStore('logs');
    for (const e of entries) store.add(e);
  });
}

export function getLogs(fromTs = 0, toTs = Date.now() + 1) {
  return tx('logs', 'readonly', (t) =>
    reqToPromise(t.objectStore('logs').index('ts').getAll(IDBKeyRange.bound(fromTs, toTs))));
}

export function clearLogs() {
  return tx('logs', 'readwrite', (t) => reqToPromise(t.objectStore('logs').clear()));
}

// 删除早于 cutoffTs 的日志，并把总数限制在 maxCount 以内。
export function pruneLogs(cutoffTs, maxCount) {
  return tx('logs', 'readwrite', async (t) => {
    const store = t.objectStore('logs');
    const oldKeys = await reqToPromise(store.index('ts').getAllKeys(IDBKeyRange.upperBound(cutoffTs, true)));
    for (const k of oldKeys) store.delete(k);
    // 同一事务内请求按顺序执行，这里的 count 已不含上面删掉的条目。
    const count = await reqToPromise(store.count());
    if (count > maxCount) {
      const extra = await reqToPromise(store.getAllKeys(null, count - maxCount));
      for (const k of extra) store.delete(k);
    }
    return { deletedOld: oldKeys.length, total: Math.min(count, maxCount) };
  });
}
