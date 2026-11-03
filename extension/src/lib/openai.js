// OpenAI（ChatGPT API）客户端：只用于 AI 纪要，只发送文字转写，不发送音频。
// key 由用户在设置页填写，放在 Authorization 头里（log.js 的 sanitize 会遮住 authorization / openaiApiKey）。

export const OPENAI_API = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

// 重试也没用的错误：key 无效、无权限、模型不存在。429 另算（限流 / 额度用完）。
const FATAL_STATUS = new Set([401, 403, 404]);

export class OpenAIError extends Error {
  constructor(message, { status = 0, code = null, type = null } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.code = code;
    this.type = type;
  }

  get fatal() {
    return FATAL_STATUS.has(this.status);
  }

  // 'invalid-key' | 'no-quota' | 'rate-limited' | 'model' | 'timeout' | 'network' | 'failed'
  get kind() {
    if (this.status === 401) return 'invalid-key';
    if (this.status === 404 || this.code === 'model_not_found') return 'model';
    if (this.status === 429) return this.code === 'insufficient_quota' ? 'no-quota' : 'rate-limited';
    if (this.code === 'timeout') return 'timeout';
    if (this.status === 0 && !this.code) return 'network';
    return 'failed';
  }
}

// 推理模型（gpt-5*、o 系列）默认推理很久，纪要用 low 足够；其它模型不认这个参数，发了会 400。
export function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model || '');
}

async function request(path, { apiKey, method = 'GET', body, timeoutMs = 60_000, fetchImpl = globalThis.fetch }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${OPENAI_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new OpenAIError(`request timed out after ${timeoutMs} ms`, { code: 'timeout' });
    throw new OpenAIError(`network error: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const err = data?.error || {};
    throw new OpenAIError(err.message || `HTTP ${res.status}`, { status: res.status, code: err.code || null, type: err.type || null });
  }
  return data;
}

// 一次 Chat Completions 调用，要求返回 JSON 对象。返回 { content, usage, model, finishReason }。
export async function chatJson({ apiKey, model, system, user, maxTokens = 12_000, timeoutMs = 120_000, fetchImpl }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_completion_tokens: maxTokens,
  };
  if (isReasoningModel(model)) body.reasoning_effort = 'low';
  const data = await request('/chat/completions', { apiKey, method: 'POST', body, timeoutMs, fetchImpl });
  const choice = data?.choices?.[0];
  return {
    content: choice?.message?.content || '',
    finishReason: choice?.finish_reason || null,
    usage: data?.usage || null,
    model: data?.model || model,
  };
}

// 设置页"测试"：查一下模型，同时验证了 key 和模型名。
export function checkModel({ apiKey, model, fetchImpl }) {
  return request(`/models/${encodeURIComponent(model)}`, { apiKey, timeoutMs: 15_000, fetchImpl });
}
