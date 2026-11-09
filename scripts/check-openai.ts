/**
 * Checks the OpenAI side against YOUR account. Costs well under a cent.
 *   npm run check:openai                 list models + report availability (free)
 *   npm run check:openai -- --probe      also verify OpenAI accepts our 3 strict JSON schemas (input tokens only)
 *   npm run check:openai -- --call       also run one real intake extraction (nano tier)
 *   add --effort=none|minimal|low|medium to test a reasoning effort
 * Never prints keys.
 */
import dotenv from 'dotenv';
import { parseEnv } from '../src/config/env';
import {
  LlmError,
  createOpenAIClient,
  createOpenAILLM,
  describeModelAvailability,
  listModelIds,
  redactSecrets,
  type ReasoningEffort,
  type UsageInfo,
} from '../src/openai/client';
import { decideFollowUps } from '../src/pipeline/followups';
import { extractBrief } from '../src/pipeline/intake';
import { ANALYSIS_JSON_SCHEMA, ANALYZE_SYSTEM_PROMPT } from '../src/prompts/analyze';
import { GENERATE_SYSTEM_PROMPT, SCRIPT_SET_JSON_SCHEMA } from '../src/prompts/generate';
import { BRIEF_EXTRACTION_JSON_SCHEMA, INTAKE_SYSTEM_PROMPT } from '../src/prompts/intake';

dotenv.config({ quiet: true });
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const effortArg = args.find((a) => a.startsWith('--effort='))?.split('=')[1] as ReasoningEffort | undefined;

const config = parseEnv(process.env);
const PRICE_PER_M: Record<string, [number, number]> = { nano: [0.2, 1.25], mini: [0.75, 4.5] }; // estimates only
const priceFor = (model: string) => (model.includes('nano') ? PRICE_PER_M.nano : model.includes('mini') ? PRICE_PER_M.mini : null);

const ids = await listModelIds(config.openaiApiKey);
const shown = ids.filter((id) => /^(gpt-5|gpt-4\.1|o\d)/.test(id) && !/(audio|realtime|image|transcribe|tts|search|codex|instruct)/.test(id));
console.log(`Models visible to this key: ${ids.length} total. Text models of interest:\n  ${shown.join('\n  ')}`);

const availability = describeModelAvailability(ids, config.models);
console.log('\nAvailability:');
for (const a of availability) {
  console.log(`  ${a.tier}: configured=${a.configured} available=${a.configuredAvailable} -> will use ${a.usable ?? 'NONE'}`);
}
const usable = Object.fromEntries(availability.map((a) => [a.tier, a.usable])) as Record<'analyze' | 'generate', string | null>;

if (flag('probe')) {
  console.log('\nSchema probes (max_output_tokens=16, so only input tokens are billed):');
  const client = createOpenAIClient(config.openaiApiKey);
  const probes = [
    { name: 'brief_extraction', model: usable.analyze, system: INTAKE_SYSTEM_PROMPT, schema: BRIEF_EXTRACTION_JSON_SCHEMA },
    { name: 'analysis', model: usable.analyze, system: ANALYZE_SYSTEM_PROMPT, schema: ANALYSIS_JSON_SCHEMA },
    { name: 'script_set', model: usable.generate, system: GENERATE_SYSTEM_PROMPT, schema: SCRIPT_SET_JSON_SCHEMA },
  ];
  for (const p of probes) {
    if (!p.model) {
      console.log(`  ${p.name}: SKIPPED (no usable model)`);
      continue;
    }
    try {
      const res = await client.responses.create({
        model: p.model,
        input: [
          { role: 'system', content: p.system },
          { role: 'user', content: 'probe' },
        ],
        text: { format: { type: 'json_schema', name: p.name, schema: p.schema, strict: true } },
        max_output_tokens: 16,
        store: false,
        ...(effortArg ? { reasoning: { effort: effortArg } } : {}),
      });
      console.log(`  ${p.name}: ACCEPTED by ${p.model} (status=${res.status}, input_tokens=${res.usage?.input_tokens ?? '?'})`);
    } catch (e) {
      console.log(`  ${p.name}: REJECTED by ${p.model}: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 400)}`);
    }
  }
}

if (flag('call')) {
  console.log('\nLive intake extraction (nano tier):');
  const usage: UsageInfo[] = [];
  const llm = createOpenAILLM(createOpenAIClient(config.openaiApiKey), {
    models: { analyze: usable.analyze ?? config.models.analyze, generate: usable.generate ?? config.models.generate },
    ...(effortArg ? { reasoningEffort: { analyze: effortArg, generate: effortArg } } : {}),
    onUsage: (u) => usage.push(u),
  });
  try {
    const brief = await extractBrief(llm, {
      platform: 'instagram',
      rawText: 'I sell an affordable vitamin C serum for oily skin. Want a reel that gets people to try it.',
    });
    for (const f of ['topic', 'product', 'audience', 'budget'] as const) console.log(`  ${f}: [${brief[f].status}] ${brief[f].value ?? '-'}`);
    console.log(`  goal=${brief.goal} tone=${brief.tone ?? '-'} hashtags=${brief.hashtags.join(',')} keywords=${brief.keywords.join(' | ')}`);
    const qs = decideFollowUps(brief);
    console.log(`  follow-up questions (${qs.length}):`);
    for (const q of qs) console.log(`    - ${q.text}`);
  } catch (e) {
    console.log(`  FAILED: ${e instanceof LlmError ? `${e.kind}: ` : ''}${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
  for (const u of usage) {
    const p = priceFor(u.model);
    const cost = p ? ((u.inputTokens * p[0] + u.outputTokens * p[1]) / 1e6).toFixed(5) : '?';
    console.log(`  usage: ${u.model} in=${u.inputTokens} out=${u.outputTokens} (reasoning=${u.reasoningTokens}) ~$${cost}`);
  }
}
