// Soniox 异步（整文件）转写：用于会后补转缺口 / 整场重转，以及校验 API key。
// 文档：https://soniox.com/docs/stt/async/async-transcription
// 流程：上传文件 → 创建转写 → 轮询状态 → 取 transcript → 删除远端转写与文件。

import { buildContext } from './soniox-realtime.js';

export const SONIOX_API = 'https://api.soniox.com/v1';
export const SONIOX_ASYNC_MODEL = 'stt-async-v5';

export class SonioxApiError extends Error {
  constructor(status, body, path) {
    super(`Soniox ${path} ${status}: ${body?.message || body?.error_message || JSON.stringify(body).slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

async function api(key, path, { method = 'GET', json, form, signal } = {}) {
  const headers = { Authorization: `Bearer ${key}` };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${SONIOX_API}${path}`, { method, headers, body, signal });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new SonioxApiError(res.status, data || {}, `${method} ${path}`);
  return data;
}

// 上传文件用 XHR：fetch 拿不到上传进度。onUploadProgress(0..1)
function uploadFile(key, blob, filename, { onUploadProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SONIOX_API}/files`);
    xhr.setRequestHeader('Authorization', `Bearer ${key}`);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onUploadProgress?.(ev.loaded / ev.total); };
    xhr.onload = () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = { message: xhr.responseText.slice(0, 300) }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new SonioxApiError(xhr.status, data || {}, 'POST /files'));
    };
    xhr.onerror = () => reject(new Error('POST /files network error'));
    xhr.onabort = () => reject(new Error('aborted'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', blob, filename);
    xhr.send(form);
  });
}

export async function validateKey(key) {
  await api(key, '/files?limit=1');
  return true;
}

// 这场会议实际用过的语言（开始时的 + 会议中改过的），而不是现在的默认设置。
export function meetingLanguageHints(meeting, fallback = []) {
  const t = meeting?.transcription || {};
  const all = [
    ...(t.languageChanges || []).flatMap((c) => [...(c.from || []), ...(c.languageHints || [])]),
    ...(t.languageHints || []),
  ];
  const uniq = [...new Set(all)];
  return uniq.length ? uniq : fallback;
}

export function buildAsyncConfig(settings, { diarization, languageHints = settings.languageHints, topic } = {}) {
  const cfg = { model: SONIOX_ASYNC_MODEL };
  if (diarization) cfg.enable_speaker_diarization = true;
  if (languageHints?.length) cfg.language_hints = languageHints;
  const context = buildContext(settings, topic);
  if (context) cfg.context = context;
  return cfg;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

// resume: { fileId, transcriptionId } —— 页面关闭后重新打开时继续轮询。
// onIds({ fileId, transcriptionId }) 用于持久化。
// onProgress({ step, ... }) 用于展示，页面按 step 翻译：
//   upload { fraction, bytes } → queued { elapsedMs } → transcribing { elapsedMs } → download
export async function transcribeBlob({ key, blob, filename, config, log, onProgress, onIds, resume = {}, signal }) {
  let { fileId, transcriptionId } = resume;
  try {
    if (!transcriptionId) {
      if (!fileId) {
        onProgress?.({ step: 'upload', fraction: 0, bytes: blob.size });
        const t0 = Date.now();
        const file = await uploadFile(key, blob, filename, {
          signal,
          onUploadProgress: (fraction) => onProgress?.({ step: 'upload', fraction, bytes: blob.size }),
        });
        fileId = file.id;
        log?.info('soniox file uploaded', { fileId, size: blob.size, ms: Date.now() - t0 });
        onIds?.({ fileId });
      }
      const tr = await api(key, '/transcriptions', { method: 'POST', json: { ...config, file_id: fileId }, signal });
      transcriptionId = tr.id;
      log?.info('soniox transcription created', { transcriptionId, config });
      onIds?.({ fileId, transcriptionId });
    }

    let delay = 2000;
    const t0 = Date.now();
    for (;;) {
      const st = await api(key, `/transcriptions/${transcriptionId}`, { signal });
      if (st.status === 'completed') {
        log?.info('soniox transcription completed', { transcriptionId, audioMs: st.audio_duration_ms, waitedMs: Date.now() - t0 });
        break;
      }
      if (st.status === 'error') {
        await cleanup(key, { fileId, transcriptionId }, log);
        throw new Error(`transcription failed: ${st.error_type || ''} ${st.error_message || ''}`);
      }
      onProgress?.({ step: st.status === 'queued' ? 'queued' : 'transcribing', elapsedMs: Date.now() - t0 });
      await sleep(delay, signal);
      delay = Math.min(delay * 1.5, 10_000);
    }

    onProgress?.({ step: 'download' });
    const transcript = await api(key, `/transcriptions/${transcriptionId}/transcript`, { signal });
    await cleanup(key, { fileId, transcriptionId }, log);
    return transcript.tokens || [];
  } catch (e) {
    log?.error('soniox async transcription failed', { error: e, fileId, transcriptionId });
    if (e instanceof SonioxApiError && e.status === 404) {
      // 远端已不存在（例如 30 天自动删除），清掉以便重新开始
      await cleanup(key, { fileId, transcriptionId }, log);
    }
    throw e;
  }
}

export async function cleanup(key, { fileId, transcriptionId }, log) {
  if (transcriptionId) {
    await api(key, `/transcriptions/${transcriptionId}`, { method: 'DELETE' })
      .catch((e) => log?.warn('delete remote transcription failed', { transcriptionId, error: e }));
  }
  if (fileId) {
    await api(key, `/files/${fileId}`, { method: 'DELETE' })
      .catch((e) => log?.warn('delete remote file failed', { fileId, error: e }));
  }
}
