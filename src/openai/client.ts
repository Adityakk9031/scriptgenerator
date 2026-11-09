import OpenAI from 'openai';
import type { StructuredLLM, StructuredRequest } from '../pipeline/llm';

/**
 * OpenAI implementation of StructuredLLM using the Responses API with strict Structured Outputs.
 * Every call: strict json_schema, a hard max_output_tokens cap, store:false (we do not keep user data at OpenAI).
 * Handles truncation, refusals, bad JSON, model-not-available (falls back down a chain) and never leaks keys in errors.
 */

export type Tier = StructuredRequest['tier'];
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ResponsesParams {
  model: string;
  input: { role: 'system' | 'user'; content: string }[];
  text: { format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: true } };
  max_output_tokens: number;
  store: false;
  reasoning?: { effort: ReasoningEffort };
}

export interface ResponseLike {
  status?: string | null;
  output_text?: string;
  incomplete_details?: { reason?: string | null } | null;
  output?: { type?: string; content?: { type?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

/** The slice of the OpenAI client we use, so tests can fake it. */
export interface OpenAIClientLike {
  responses: { create(params: ResponsesParams): Promise<ResponseLike> };
}

export type LlmErrorKind = 'truncated' | 'refusal' | 'invalid_json' | 'empty' | 'model_unavailable' | 'api';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface UsageInfo {
  tier: Tier;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface OpenAILLMOptions {
  models: { analyze: string; generate: string };
  /** Tried in order if the configured model is unavailable on this account. */
  fallbacks?: { analyze: string[]; generate: string[] };
  /** Reasoning effort per tier for models that support it. Reasoning tokens count against max_output_tokens. */
  reasoningEffort?: Partial<Record<Tier, ReasoningEffort>>;
  onUsage?: (usage: UsageInfo) => void;
}

export const DEFAULT_FALLBACKS = {
  analyze: ['gpt-5-nano', 'gpt-4.1-nano'],
  generate: ['gpt-5-mini', 'gpt-4.1-mini'],
};

/** Only reasoning-capable families accept the `reasoning` parameter. */
export const supportsReasoning = (model: string): boolean => /^(gpt-5|o\d)/.test(model);

/** Remove anything key-shaped before an error message can reach logs or the UI. */
export function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

const errStatus = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number'
    ? (e as { status: number }).status
    : undefined;
const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isModelUnavailable(e: unknown): boolean {
  const status = errStatus(e);
  if (status === 404 || errCode(e) === 'model_not_found') return true;
  return status === 400 && /model/i.test(errMessage(e)) && /(not (exist|found|available|supported)|no access|does not have access)/i.test(errMessage(e));
}

/** A 400 complaining about the reasoning/effort parameter (e.g. the model does not accept that effort value). */
const isReasoningParamError = (e: unknown): boolean =>
  errStatus(e) === 400 && /(reasoning|effort)/i.test(errMessage(e));

export function createOpenAILLM(client: OpenAIClientLike, opts: OpenAILLMOptions): StructuredLLM {
  const chains: Record<Tier, string[]> = {
    analyze: [...new Set([opts.models.analyze, ...(opts.fallbacks ?? DEFAULT_FALLBACKS).analyze])],
    generate: [...new Set([opts.models.generate, ...(opts.fallbacks ?? DEFAULT_FALLBACKS).generate])],
  };
  const position: Record<Tier, number> = { analyze: 0, generate: 0 }; // remembered once a fallback is chosen
  const noReasoning = new Set<string>(); // models that rejected the reasoning parameter

  async function callOnce(model: string, req: StructuredRequest): Promise<unknown> {
    const effort = opts.reasoningEffort?.[req.tier];
    const params: ResponsesParams = {
      model,
      input: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      text: { format: { type: 'json_schema', name: req.schemaName, schema: req.jsonSchema, strict: true } },
      max_output_tokens: req.maxOutputTokens,
      store: false,
    };
    if (effort && supportsReasoning(model) && !noReasoning.has(model)) params.reasoning = { effort };

    let res: ResponseLike;
    try {
      res = await client.responses.create(params);
    } catch (e) {
      if (params.reasoning && isReasoningParamError(e)) {
        noReasoning.add(model); // remember, then retry once without it
        return callOnce(model, req);
      }
      throw e;
    }
    return interpret(res, model, req.tier);
  }

  function interpret(res: ResponseLike, model: string, tier: Tier): unknown {
    const usage = res.usage ?? {};
    opts.onUsage?.({
      tier,
      model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    });

    const refusal = res.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'refusal');
    if (refusal) throw new LlmError('refusal', 'The model declined to answer this request.');

    if (res.status === 'incomplete') {
      const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
      throw new LlmError(
        'truncated',
        `The model hit the output limit (${res.incomplete_details?.reason ?? 'unknown'})` +
          (reasoning > 0 ? `; ${reasoning} tokens were spent on reasoning` : '') +
          '.',
      );
    }

    const text = res.output_text?.trim();
    if (!text) throw new LlmError('empty', 'The model returned no text.');
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError('invalid_json', 'The model did not return valid JSON.');
    }
  }

  return {
    async generate(req) {
      const chain = chains[req.tier];
      while (position[req.tier] < chain.length) {
        const model = chain[position[req.tier]]!;
        try {
          return await callOnce(model, req);
        } catch (e) {
          if (e instanceof LlmError) throw e;
          if (isModelUnavailable(e)) {
            position[req.tier]++; // try the next model in the chain, and keep it for later calls
            continue;
          }
          throw new LlmError('api', redactSecrets(errMessage(e)).slice(0, 300), errStatus(e));
        }
      }
      throw new LlmError('model_unavailable', `None of these models is available on this account: ${chain.join(', ')}.`);
    },
  };
}

/** Real client wrapped to our minimal interface. The SDK retries 429/5xx/connection errors itself. */
export function createOpenAIClient(apiKey: string): OpenAIClientLike {
  const real = new OpenAI({ apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    responses: {
      create: async (params) => (await real.responses.create(params as never)) as unknown as ResponseLike,
    },
  };
}

// ---------- model availability ----------

export interface ModelAvailability {
  tier: Tier;
  configured: string;
  configuredAvailable: boolean;
  /** First model in the chain that exists on the account, or null. */
  usable: string | null;
}

/** Pure: compares the account's model IDs with each tier's chain. */
export function describeModelAvailability(
  availableIds: string[],
  models: { analyze: string; generate: string },
  fallbacks: { analyze: string[]; generate: string[] } = DEFAULT_FALLBACKS,
): ModelAvailability[] {
  const have = new Set(availableIds);
  return (['analyze', 'generate'] as const).map((tier) => {
    const chain = [models[tier], ...fallbacks[tier]];
    return {
      tier,
      configured: models[tier],
      configuredAvailable: have.has(models[tier]),
      usable: chain.find((m) => have.has(m)) ?? null,
    };
  });
}

/** Free call: lists model IDs visible to this key. */
export async function listModelIds(apiKey: string): Promise<string[]> {
  const real = new OpenAI({ apiKey, maxRetries: 2, timeout: 30_000 });
  const ids: string[] = [];
  for await (const m of real.models.list()) ids.push(m.id);
  return ids.sort();
}
