import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatJson, checkModel, OpenAIError, isReasoningModel } from '../extension/src/lib/openai.js';
import { LatencyStats, percentile } from '../extension/src/lib/latency.js';
import { CaptionState, CAPTION_KEEP_MS } from '../extension/src/lib/captions.js';

const fakeFetch = (status, body, seen = []) => async (url, init) => {
  seen.push({ url, init });
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

test('chatJson: sends JSON mode with the key in the header, reasoning effort only for reasoning models', async () => {
  const seen = [];
  const res = await chatJson({
    apiKey: 'sk-test', model: 'gpt-5-mini', system: 's', user: 'u',
    fetchImpl: fakeFetch(200, { model: 'gpt-5-mini-2025', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } }, seen),
  });
  assert.equal(res.content, '{"a":1}');
  assert.equal(res.model, 'gpt-5-mini-2025');
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(isReasoningModel('gpt-4.1-mini'), false);
  assert.equal(isReasoningModel('o4-mini'), true);
});

test('OpenAIError: kinds from status and error code', async () => {
  const kind = async (status, error) => {
    try {
      await checkModel({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(status, { error }) });
      return 'ok';
    } catch (e) {
      assert.ok(e instanceof OpenAIError);
      return e.kind;
    }
  };
  assert.equal(await kind(401, { message: 'bad key' }), 'invalid-key');
  assert.equal(await kind(404, { code: 'model_not_found' }), 'model');
  assert.equal(await kind(429, { code: 'insufficient_quota' }), 'no-quota');
  assert.equal(await kind(429, { code: 'rate_limit_exceeded' }), 'rate-limited');
  assert.equal(await kind(500, {}), 'failed');
  await assert.rejects(checkModel({ apiKey: 'k', model: 'm', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e.kind === 'network');
  assert.equal(new OpenAIError('x', { code: 'bad-reply' }).kind, 'failed');
});

test('LatencyStats: percentiles, cap and reset', () => {
  const s = new LatencyStats(5);
  assert.equal(s.summary(), null);
  for (const v of [100, 900, 300, 200, 500, 400]) s.add(v); // 第一个被挤掉
  assert.deepEqual(s.summary(), { n: 5, p50: 400, p95: 900, max: 900 });
  s.add(NaN);
  assert.equal(s.count, 5);
  s.reset();
  assert.equal(s.summary(), null);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
});

test('CaptionState: live line wins, committed line stays a while with its late translation', () => {
  const c = new CaptionState();
  c.partial('them', { finalText: 'Hello', pendingText: 'wor' }, 1000);
  assert.deepEqual(c.rows(1000), [{ source: 'them', text: 'Hello', pending: 'wor', translation: '' }]);
  c.commit('them', { startMs: 500, text: 'Hello world.' }, 2000);
  c.partial('them', { finalText: '', pendingText: '' }, 2000);
  c.partial('me', { finalText: '', pendingText: '好' }, 2500);
  c.update('them', { startMs: 500, translation: '你好世界。' }, 3000);
  c.update('them', { startMs: 1, translation: 'not this one' }, 3100);
  assert.deepEqual(c.rows(3100), [
    { source: 'me', text: '', pending: '好', translation: '' },
    { source: 'them', text: 'Hello world.', pending: '', translation: '你好世界。' },
  ]);
  c.partial('me', { finalText: '', pendingText: '' }, 3200);
  assert.deepEqual(c.rows(3000 + CAPTION_KEEP_MS), [], 'committed line disappears after a quiet spell');
});
