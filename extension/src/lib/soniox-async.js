// Soniox 异步（整文件）转写：用于会后补转缺口 / 整场重转，以及校验 API key。
// 文档：https://soniox.com/docs/stt/async/async-transcription
// 流程：上传文件 → 创建转写 → 轮询状态 → 取 transcript → 删除远端转写与文件。

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

export async function validateKey(key) {
  await api(key, '/files?limit=1');
  return true;
}

export function buildAsyncConfig(settings, { diarization }) {
  const cfg = { model: SONIOX_ASYNC_MODEL };
  if (diarization) cfg.enable_speaker_diarization = true;
  if (settings.languageHints?.length) cfg.language_hints = settings.languageHints;
  if (settings.contextTerms?.length) cfg.context = { terms: settings.contextTerms };
  return cfg;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

// resume: { fileId, transcriptionId } —— 页面关闭后重新打开时继续轮询。
// onIds({ fileId, transcriptionId }) 用于持久化，onProgress(text) 用于展示。
export async function transcribeBlob({ key, blob, filename, config, log, onProgress, onIds, resume = {}, signal }) {
  let { fileId, transcriptionId } = resume;
  try {
    if (!transcriptionId) {
      if (!fileId) {
        onProgress?.(`上传录音（${Math.round(blob.size / 1024 / 1024 * 10) / 10} MB）…`);
        const form = new FormData();
        form.append('file', blob, filename);
        const t0 = Date.now();
        const file = await api(key, '/files', { method: 'POST', form, signal });
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
        throw new Error(`转写失败：${st.error_type || ''} ${st.error_message || ''}`);
      }
      onProgress?.(st.status === 'queued' ? '排队中…' : `转写中…（已等待 ${Math.round((Date.now() - t0) / 1000)}s）`);
      await sleep(delay, signal);
      delay = Math.min(delay * 1.5, 10_000);
    }

    onProgress?.('下载结果…');
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
