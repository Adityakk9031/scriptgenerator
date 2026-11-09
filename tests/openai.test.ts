import { describe, expect, it } from 'vitest';
import {
  LlmError,
  createOpenAILLM,
  describeModelAvailability,
  redactSecrets,
  supportsReasoning,
  type OpenAIClientLike,
  type ResponseLike,
  type ResponsesParams,
  type UsageInfo,
} from '../src/openai/client';
import type { StructuredRequest } from '../src/pipeline/llm';

const REQ: StructuredRequest = {
  tier: 'analyze',
  system: 'SYSTEM TEXT',
  user: 'USER TEXT',
  schemaName: 'thing',
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  maxOutputTokens: 500,
};
const MODELS = { analyze: 'gpt-5.4-nano', generate: 'gpt-5.4-mini' };

type Step = ResponseLike | Error;
/** Fake client: plays back steps in order, records every request. */
function fake(...steps: Step[]) {
  const calls: ResponsesParams[] = [];
  const client: OpenAIClientLike = {
    responses: {
      create: async (params) => {
        calls.push(params);
        const next = steps.shift();
        if (!next) throw new Error('fake ran out of steps');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, calls };
}
/** Awaits a promise that must reject and returns the error typed as LlmError. */
const rejects = (p: Promise<unknown>): Promise<LlmError> =>
  p.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (e: unknown) => e as LlmError,
  );
const ok = (obj: unknown = { ok: true }, extra: Partial<ResponseLike> = {}): ResponseLike => ({
  status: 'completed',
  output_text: JSON.stringify(obj),
  usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } },
  ...extra,
});
const apiError = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

describe('request shape', () => {
  it('sends strict json_schema, the token cap, store:false, system+user messages, and no temperature', async () => {
    const f = fake(ok());
    await createOpenAILLM(f.client, { models: MODELS }).generate(REQ);
    const p = f.calls[0]!;
    expect(p.model).toBe('gpt-5.4-nano');
    expect(p.input).toEqual([
      { role: 'system', content: 'SYSTEM TEXT' },
      { role: 'user', content: 'USER TEXT' },
    ]);
    expect(p.text.format).toEqual({ type: 'json_schema', name: 'thing', schema: REQ.jsonSchema, strict: true });
    expect(p.max_output_tokens).toBe(500);
    expect(p.store).toBe(false);
    expect('temperature' in p).toBe(false);
  });

  it('maps the tier to the configured model', async () => {
    const f = fake(ok(), ok());
    const llm = createOpenAILLM(f.client, { models: MODELS });
    await llm.generate({ ...REQ, tier: 'analyze' });
    await llm.generate({ ...REQ, tier: 'generate' });
    expect(f.calls.map((c) => c.model)).toEqual(['gpt-5.4-nano', 'gpt-5.4-mini']);
  });

  it('returns the parsed JSON', async () => {
    const f = fake(ok({ ok: true, n: 3 }));
    expect(await createOpenAILLM(f.client, { models: MODELS }).generate(REQ)).toEqual({ ok: true, n: 3 });
  });
});

describe('reasoning parameter', () => {
  it('is sent only when configured AND the model supports it', async () => {
    const f = fake(ok(), ok());
    const llm = createOpenAILLM(f.client, { models: { analyze: 'gpt-5.4-nano', generate: 'gpt-4.1-mini' }, reasoningEffort: { analyze: 'low', generate: 'low' } });
    await llm.generate({ ...REQ, tier: 'analyze' });
    await llm.generate({ ...REQ, tier: 'generate' });
    expect(f.calls[0]!.reasoning).toEqual({ effort: 'low' });
    expect('reasoning' in f.calls[1]!).toBe(false);
  });
  it('is omitted by default', async () => {
    const f = fake(ok());
    await createOpenAILLM(f.client, { models: MODELS }).generate(REQ);
    expect('reasoning' in f.calls[0]!).toBe(false);
  });
  it('retries once without it, and remembers, when the model rejects the effort value', async () => {
    const f = fake(apiError(400, "Unsupported value: 'minimal' is not supported for reasoning.effort"), ok(), ok());
    const llm = createOpenAILLM(f.client, { models: MODELS, reasoningEffort: { analyze: 'minimal' } });
    await llm.generate(REQ);
    await llm.generate(REQ);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.reasoning).toBeDefined();
    expect('reasoning' in f.calls[1]!).toBe(false);
    expect('reasoning' in f.calls[2]!).toBe(false); // remembered
  });
  it('supportsReasoning matches the gpt-5 and o-series families only', () => {
    for (const m of ['gpt-5.4-nano', 'gpt-5-mini', 'o3', 'o4-mini']) expect(supportsReasoning(m)).toBe(true);
    for (const m of ['gpt-4.1-mini', 'gpt-4o']) expect(supportsReasoning(m)).toBe(false);
  });
});

describe('response handling', () => {
  it('throws LlmError(truncated) on an incomplete response and mentions reasoning tokens', async () => {
    const f = fake({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 10, output_tokens: 500, output_tokens_details: { reasoning_tokens: 480 } },
    });
    const err = await rejects(createOpenAILLM(f.client, { models: MODELS }).generate(REQ));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('truncated');
    expect(err.message).toContain('480 tokens were spent on reasoning');
  });
  it('throws LlmError(refusal) when the model refuses', async () => {
    const f = fake({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] });
    const err = await rejects(createOpenAILLM(f.client, { models: MODELS }).generate(REQ));
    expect(err.kind).toBe('refusal');
  });
  it('throws LlmError(empty) and LlmError(invalid_json) for blank or broken output', async () => {
    const f = fake({ status: 'completed', output_text: '  ' }, { status: 'completed', output_text: '{not json' });
    const llm = createOpenAILLM(f.client, { models: MODELS });
    expect((await rejects(llm.generate(REQ))).kind).toBe('empty');
    expect((await rejects(llm.generate(REQ))).kind).toBe('invalid_json');
  });
  it('reports token usage per call', async () => {
    const seen: UsageInfo[] = [];
    const f = fake(ok({ ok: true }, { usage: { input_tokens: 321, output_tokens: 45, output_tokens_details: { reasoning_tokens: 7 } } }));
    await createOpenAILLM(f.client, { models: MODELS, onUsage: (u) => seen.push(u) }).generate(REQ);
    expect(seen).toEqual([{ tier: 'analyze', model: 'gpt-5.4-nano', inputTokens: 321, outputTokens: 45, reasoningTokens: 7 }]);
  });
});

describe('model fallback', () => {
  it('moves down the chain when the model does not exist, and remembers it', async () => {
    const f = fake(apiError(404, 'The model `gpt-5.4-nano` does not exist', 'model_not_found'), ok(), ok());
    const llm = createOpenAILLM(f.client, { models: MODELS });
    await llm.generate(REQ);
    await llm.generate(REQ);
    expect(f.calls.map((c) => c.model)).toEqual(['gpt-5.4-nano', 'gpt-5-nano', 'gpt-5-nano']);
  });
  it('treats a 400 "model not found / no access" as unavailable too', async () => {
    const f = fake(apiError(400, 'The requested model does not exist or you do not have access to it'), ok());
    await createOpenAILLM(f.client, { models: MODELS }).generate(REQ);
    expect(f.calls[1]!.model).toBe('gpt-5-nano');
  });
  it('throws model_unavailable when the whole chain is exhausted', async () => {
    const gone = () => apiError(404, 'no such model', 'model_not_found');
    const f = fake(gone(), gone(), gone());
    const err = await rejects(createOpenAILLM(f.client, { models: MODELS }).generate(REQ));
    expect(err.kind).toBe('model_unavailable');
    expect(err.message).toContain('gpt-5.4-nano');
    expect(err.message).toContain('gpt-4.1-nano');
  });
  it('does not fall back on unrelated errors', async () => {
    const f = fake(apiError(429, 'rate limited'));
    const err = await rejects(createOpenAILLM(f.client, { models: MODELS }).generate(REQ));
    expect(err.kind).toBe('api');
    expect(err.status).toBe(429);
    expect(f.calls).toHaveLength(1);
  });
  it('uses custom fallbacks and de-duplicates the chain', async () => {
    const f = fake(apiError(404, 'x', 'model_not_found'), ok());
    await createOpenAILLM(f.client, {
      models: MODELS,
      fallbacks: { analyze: ['gpt-5.4-nano', 'my-small-model'], generate: [] },
    }).generate(REQ);
    expect(f.calls.map((c) => c.model)).toEqual(['gpt-5.4-nano', 'my-small-model']);
  });
});

describe('error safety', () => {
  it('redacts key-shaped strings from API errors', async () => {
    const f = fake(apiError(401, 'Incorrect API key provided: sk-proj-abcDEF123456789xyz. You can find your key...'));
    const err = await rejects(createOpenAILLM(f.client, { models: MODELS }).generate(REQ));
    expect(err.kind).toBe('api');
    expect(err.message).not.toContain('abcDEF123456789xyz');
    expect(err.message).toContain('sk-***');
  });
  it('redactSecrets handles bearer tokens and sk- keys', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer ***');
    expect(redactSecrets('key sk-test-secret-456 here')).toBe('key sk-*** here');
    expect(redactSecrets('nothing secret')).toBe('nothing secret');
  });
});

describe('describeModelAvailability', () => {
  it('flags a configured model that the account lacks and suggests the first usable fallback', () => {
    const r = describeModelAvailability(['gpt-5-nano', 'gpt-5.4-mini', 'gpt-4o'], MODELS);
    expect(r).toEqual([
      { tier: 'analyze', configured: 'gpt-5.4-nano', configuredAvailable: false, usable: 'gpt-5-nano' },
      { tier: 'generate', configured: 'gpt-5.4-mini', configuredAvailable: true, usable: 'gpt-5.4-mini' },
    ]);
  });
  it('returns usable = null when nothing in the chain exists', () => {
    expect(describeModelAvailability(['gpt-4o'], MODELS).every((m) => m.usable === null)).toBe(true);
  });
});
