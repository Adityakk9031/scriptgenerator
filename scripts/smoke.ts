/**
 * One REAL end-to-end generation with your keys. Costs real money (roughly $0.10-0.40 on Apify plus cents on OpenAI;
 * re-running the same brief on the same day reuses the scrape cache). Never prints keys.
 *
 *   npm run smoke
 */
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApifyDeps } from '../src/apify/client';
import { parseEnv } from '../src/config/env';
import { LlmError, createOpenAIClient, createOpenAILLM, redactSecrets, type UsageInfo } from '../src/openai/client';
import { decideFollowUps } from '../src/pipeline/followups';
import { ScriptGenerationError } from '../src/pipeline/generate';
import { completeBrief, extractBrief } from '../src/pipeline/intake';
import { runPipeline } from '../src/pipeline/run';

dotenv.config({ quiet: true });
const config = parseEnv(process.env);
const startedAt = new Date();
const CACHED_ONLY = process.argv.includes('--cached-only');

const BRIEF =
  'I sell a $15 vitamin C serum for oily skin. My audience is college students aged 18-24 who struggle with breakouts and have a small budget. I want a TikTok that gets them to try it.';

const usage: UsageInfo[] = [];
const llm = createOpenAILLM(createOpenAIClient(config.openaiApiKey), {
  models: config.models,
  reasoningEffort: { analyze: 'low', generate: 'low' },
  onUsage: (u) => usage.push(u),
});

const PRICE: Record<string, [number, number]> = { nano: [0.2, 1.25], mini: [0.75, 4.5] };
function reportUsage(): void {
  let total = 0;
  for (const u of usage) {
    const p = u.model.includes('nano') ? PRICE.nano! : PRICE.mini!;
    const cost = (u.inputTokens * p[0] + u.outputTokens * p[1]) / 1e6;
    total += cost;
    console.log(`  ${u.model}: in=${u.inputTokens} out=${u.outputTokens} (reasoning=${u.reasoningTokens}) ~$${cost.toFixed(4)}`);
  }
  console.log(`  OpenAI total ~$${total.toFixed(4)} (estimated from list prices)`);
}

async function reportApifyCost(): Promise<void> {
  await new Promise((r) => setTimeout(r, 8000)); // usage figures settle shortly after a run ends
  const client = new ApifyClient({ token: config.apifyToken });
  const { items } = await client.runs().list({ limit: 10, desc: true });
  let total = 0;
  for (const item of items.filter((r) => new Date(r.startedAt) >= startedAt)) {
    const run = await client.run(item.id).get();
    total += run?.usageTotalUsd ?? 0;
    console.log(`  run ${item.id}: ${run?.status} $${(run?.usageTotalUsd ?? 0).toFixed(4)}`);
  }
  console.log(`  Apify total $${total.toFixed(4)}`);
}

try {
  const brief = await extractBrief(llm, { platform: 'tiktok', rawText: BRIEF });
  console.log('BRIEF');
  for (const f of ['topic', 'product', 'audience', 'budget'] as const) console.log(`  ${f}: [${brief[f].status}] ${brief[f].value ?? '-'}`);
  console.log(`  hashtags: ${brief.hashtags.join(', ')}`);
  console.log(`  follow-up questions: ${decideFollowUps(brief).map((q) => q.text).join(' | ') || 'none'}`);

  const apify = createApifyDeps(config);
  if (CACHED_ONLY) {
    // Re-use today's scrape: same hashtags as the recorded run, and refuse anything that would cost money.
    brief.hashtags = ['skincaretiktok', 'oilyskinsolutions', 'vitamincserum'];
    apify.runner = {
      run: async (actorId) => {
        console.log(`  REFUSED paid scrape (cache miss): ${actorId}`);
        throw new Error(`cache miss for ${actorId}`);
      },
    };
  }

  const resolved = await completeBrief(llm, brief, decideFollowUps(brief), {});
  const result = await runPipeline({ llm, apify }, resolved);

  await mkdir('data/raw-samples', { recursive: true });
  await writeFile(path.join('data', 'raw-samples', 'smoke-result.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log(`\nSTATS ${JSON.stringify(result.stats)} attempts=${result.attempts} degraded=${result.degraded}`);
  console.log(`BENCHMARKS ${JSON.stringify(result.benchmarks)}`);
  for (const s of result.set.scripts) {
    console.log(`\n=== ${s.label} [${s.hook_type}] window=${s.word_count_window}w total=${s.word_count_total}w ~${s.est_seconds}s`);
    console.log(`HOOK: ${s.segments.hook}\nHOLD: ${s.segments.hold}`);
    s.segments.body.forEach((b, i) => console.log(`BODY ${i + 1}: ${b}`));
    console.log(`CLOSE: ${s.segments.close}\nON SCREEN: ${s.on_screen_text.join(' / ')}`);
    console.log(`WHY: ${s.why_it_works}\nPROFILE: ${s.expected_response.profile}\nBENCHMARK: ${s.expected_response.benchmark}\nBEST FOR: ${s.best_for}\nRISK: ${s.risk}`);
  }
  console.log(`\nISSUES (${result.issues.length}):`);
  for (const i of result.issues) console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
} catch (e) {
  console.log(`\nFAILED: ${e instanceof LlmError ? `${e.kind}: ` : ''}${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  if (e instanceof ScriptGenerationError) for (const i of e.issues) console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
}

console.log('\nCOST');
reportUsage();
if (CACHED_ONLY) console.log('  Apify: $0 (cache-only run)');
else await reportApifyCost();
