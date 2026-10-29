// 日志：打印到各上下文的 console，同时批量写入 IndexedDB（logs 表），
// 可在设置页 / 历史页导出为 .jsonl 用于排查问题。
//
// 用法：
//   const log = createLogger('offscreen');
//   log.info('ws open', { source: 'them' });
//   const mlog = log.child({ meetingId });   // 之后的日志都带 meetingId

import { addLogs, getLogs, pruneLogs } from './db.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FLUSH_MS = 1000;
const FLUSH_BATCH = 50;
export const LOG_RETENTION_DAYS = 14;
export const LOG_MAX_ENTRIES = 50000;

let minLevel = LEVELS.info;
let queue = [];
let flushTimer = null;

// offscreen 文档没有 chrome.storage，由调用方显式设置。
export function setLogLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
}

// 跟随设置里的 logLevel
try {
  chrome.storage.local.get('settings').then(({ settings }) => {
    if (settings?.logLevel && LEVELS[settings.logLevel]) minLevel = LEVELS[settings.logLevel];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const lvl = area === 'local' && changes.settings?.newValue?.logLevel;
    if (lvl && LEVELS[lvl]) minLevel = LEVELS[lvl];
  });
} catch { /* 非扩展环境（单元测试） */ }

const SENSITIVE = /^(api_?key|sonioxApiKey|key|authorization)$/i;

function sanitize(data, depth = 0) {
  if (data == null || depth > 4) return data;
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  if (typeof data === 'string') return data.length > 2000 ? `${data.slice(0, 2000)}…(${data.length})` : data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return `<binary ${data.byteLength}B>`;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return `<blob ${data.size}B ${data.type}>`;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = SENSITIVE.test(k) ? (v ? '***' : v) : sanitize(v, depth + 1);
  }
  return out;
}

function scheduleFlush(immediate) {
  if (immediate || queue.length >= FLUSH_BATCH) {
    flushLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, FLUSH_MS);
  }
}

export async function flushLogs() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    await addLogs(batch);
  } catch (e) {
    console.error('[log] failed to persist logs', e);
  }
}

function emit(ctx, bound, level, msg, data) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: Date.now(),
    level,
    ctx,
    msg,
    ...(data !== undefined ? { data: sanitize(data) } : {}),
    ...bound,
  };
  const prefix = `[${ctx}]${bound.meetingId ? `[${bound.meetingId.slice(-6)}]` : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
  data !== undefined ? fn(prefix, msg, data) : fn(prefix, msg);
  queue.push(entry);
  scheduleFlush(LEVELS[level] >= LEVELS.warn);
}

export function createLogger(ctx, bound = {}) {
  return {
    debug: (msg, data) => emit(ctx, bound, 'debug', msg, data),
    info: (msg, data) => emit(ctx, bound, 'info', msg, data),
    warn: (msg, data) => emit(ctx, bound, 'warn', msg, data),
    error: (msg, data) => emit(ctx, bound, 'error', msg, data),
    child: (extra) => createLogger(ctx, { ...bound, ...extra }),
    flush: flushLogs,
  };
}

// 捕获未处理的异常，避免"静默失败"。
export function installGlobalErrorHandlers(log) {
  const g = globalThis;
  g.addEventListener?.('error', (e) => {
    log.error('uncaught error', { message: e.message, file: e.filename, line: e.lineno, col: e.colno, error: e.error });
  });
  g.addEventListener?.('unhandledrejection', (e) => {
    log.error('unhandled rejection', { reason: e.reason });
  });
  g.addEventListener?.('pagehide', () => { flushLogs(); });
}

export function pruneOldLogs() {
  return pruneLogs(Date.now() - LOG_RETENTION_DAYS * 86400e3, LOG_MAX_ENTRIES);
}

// 导出日志为 jsonl 文本。第一行是环境信息。
export async function buildLogExport({ fromTs = 0, toTs = Date.now() + 1, meta = {}, filter = null } = {}) {
  await flushLogs();
  let logs = await getLogs(fromTs, toTs);
  if (filter) logs = logs.filter(filter);
  const header = {
    type: 'meetscribe-log-export',
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    range: { from: new Date(fromTs).toISOString(), to: new Date(Math.min(toTs, Date.now())).toISOString() },
    count: logs.length,
    ...meta,
  };
  const lines = [JSON.stringify(header)];
  for (const l of logs) lines.push(JSON.stringify({ ...l, t: new Date(l.ts).toISOString() }));
  return lines.join('\n') + '\n';
}
