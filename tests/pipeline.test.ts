import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskCache } from '../src/apify/cache';
import type { ApifyRunner } from '../src/apify/runner';
import { parseEnv } from '../src/config/env';
import { LlmError } from '../src/openai/client';
import { resolveBrief } from '../src/pipeline/followups';
import { ScriptGenerationError, generateScripts } from '../src/pipeline/generate';
import type { StructuredLLM, StructuredRequest } from '../src/pipeline/llm';
import { computeBenchmarks } from '../src/pipeline/stats';
import type { Analysis } from '../src/prompts/analyze';
import type { Brief } from '../src/schemas/brief';
import { createApp } from '../src/server/app';
import { formatClock, scriptSections, scrollPxPerSecond, splitPlaceholders, timedSections } from '../src/web/prompterMath';

const fx = (name: string): unknown[] => JSON.parse(readFileSync(path.resolve('tests', 'fixtures', `${name}.json`), 'utf8'));
const cfg = parseEnv({ APIFY_TOKEN: 'apify_test_token_123', OPENAI_API_KEY: 'sk-test-secret-456' });

function words(n: number, seed: string): string {
  const parts = Array.from({ length: n }, (_, i) => `${seed}${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);
  const out: string[] = [];
  for (let i = 0; i < n; i += 8) out.push(`${parts.slice(i, i + 8).join(' ')}.`);
  return out.join(' ');
}
const script = (seed: string, hook_type: string, hookWords = 8) => ({
  label: `Script ${seed}`, hook_type,
  segments: { hook: words(hookWords, `${seed}h`), hold: words(28, `${seed}o`), body: [words(45, `${seed}p`), words(45, `${seed}q`)], close: words(20, `${seed}c`) },
  on_screen_text: ['one step'], word_count_total: 0, word_count_window: 0, est_seconds: 1,
  why_it_works: 'pattern', expected_response: { profile: 'Drives saves.', benchmark: 'An estimate for this niche.' }, best_for: 'x', risk: 'y',
});
const goodSet = { assumptions: [], scripts: [script('a', 'contrarian_claim'), script('b', 'mistake_callout'), script('c', 'number_result')] };
const field = (value: string | null, status: 'clear' | 'missing') => ({ value, status });
const extraction = { topic: field('skincare', 'clear'), product: field('serum', 'clear'), audience: field('students', 'clear'), budget: field('under $20', 'clear'), goal: 'promote', tone: null, hashtags: ['skincare'], keywords: [] };
const analysis: Analysis = { hook_patterns: [{ hook_type: 'mistake_callout', example_opening: 'You are doing it wrong', why_it_works: 'Self-check.' }], structures: ['a'], pacing_notes: 'fast', tone_notes: 'casual', audience_vocabulary: ['breakouts'], questions_to_answer: [], objections_to_preempt: [], intent_signals: [], angles: [] };
const brief: Brief = { platform: 'tiktok', rawText: 'sell serum', ...extraction, goal: 'promote' };
const params = { resolved: resolveBrief(brief), analysis, benchmarks: computeBenchmarks([]), sources: [] };

function fakeLLM(...replies: unknown[]): StructuredLLM & { reqs: StructuredRequest[] } {
  const reqs: StructuredRequest[] = [];
  return { reqs, generate: async (r) => { reqs.push(r); const n = replies.shift(); if (n instanceof Error) throw n; return n; } };
}

describe('generateScripts repair loop', () => {
  it('returns on first valid output', async () => {
    const llm = fakeLLM(goodSet);
    const r = await generateScripts(llm, params);
    expect(r.attempts).toBe(1);
    expect(llm.reqs[0]!.tier).toBe('generate');
  });
  it('repairs once, telling the model exactly what failed', async () => {
    const bad = { ...goodSet, scripts: [script('a', 'contrarian_claim', 14), goodSet.scripts[1], goodSet.scripts[2]] };
    const llm = fakeLLM(bad, goodSet);
    const r = await generateScripts(llm, params);
    expect(r.attempts).toBe(2);
    expect(llm.reqs[1]!.user).toContain('at most 10');
  });
  it('drops scripts that fail twice when two survive', async () => {
    const bad = { ...goodSet, scripts: [script('a', 'contrarian_claim', 14), goodSet.scripts[1], goodSet.scripts[2]] };
    const r = await generateScripts(fakeLLM(bad, bad), params);
    expect(r.degraded).toBe(true);
    expect(r.set.scripts).toHaveLength(2);
  });
  it('throws when fewer than two survive', async () => {
    const bad = { assumptions: [], scripts: [script('a', 'contrarian_claim', 14), script('b', 'mistake_callout', 14), script('c', 'number_result', 14)] };
    await expect(generateScripts(fakeLLM(bad, bad), params)).rejects.toBeInstanceOf(ScriptGenerationError);
  });
  it('keeps the usable scripts from attempt 1 when the repair attempt is cut off', async () => {
    const bad = { ...goodSet, scripts: [script('a', 'contrarian_claim', 14), goodSet.scripts[1], goodSet.scripts[2]] };
    const r = await generateScripts(fakeLLM(bad, new LlmError('truncated', 'cut')), params);
    expect(r.degraded).toBe(true);
    expect(r.set.scripts).toHaveLength(2);
  });
  it('still reports the failure when two truncated attempts leave nothing', async () => {
    const llm = fakeLLM(new LlmError('truncated', 'cut'), new LlmError('truncated', 'cut'));
    await expect(generateScripts(llm, params)).rejects.toBeInstanceOf(LlmError);
  });
  it('retries a truncated response once', async () => {
    const llm = fakeLLM(new LlmError('truncated', 'cut'), goodSet);
    expect((await generateScripts(llm, params)).attempts).toBe(2);
  });
});

describe('API with fake Apify + fake model (full pipeline on real fixtures)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'scriptgen-api-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const runner: ApifyRunner = {
    run: async (actorId, _i, o) => (actorId === cfg.actors.tiktokVideos ? fx('tiktok-videos') : actorId === cfg.actors.tiktokComments ? fx('tiktok-comments') : []).slice(0, o.maxItems),
  };
  const app = (llm: StructuredLLM) => createApp(cfg, { llm, apify: { runner, cache: createDiskCache(dir), actors: cfg.actors } });

  it('intake returns the brief and no questions when everything is clear', async () => {
    const res = await request(app(fakeLLM(extraction))).post('/api/intake').send({ platform: 'tiktok', text: 'sell serum' });
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });
  it('intake asks when a field is missing, and rejects a bad body', async () => {
    const gap = { ...extraction, budget: field(null, 'missing') };
    const res = await request(app(fakeLLM(gap))).post('/api/intake').send({ platform: 'tiktok', text: 'sell serum' });
    expect(res.body.questions).toHaveLength(1);
    expect((await request(app(fakeLLM())).post('/api/intake').send({ platform: 'x', text: 'a' })).status).toBe(400);
  });
  it('generate runs scrape -> score -> analyse -> write', async () => {
    const llm = fakeLLM(analysis, goodSet);
    const res = await request(app(llm)).post('/api/generate').send({ brief });
    expect(res.status).toBe(200);
    expect(res.body.set.scripts).toHaveLength(3);
    expect(res.body.stats.paidExcluded).toBeGreaterThan(0);
    expect(res.body.set.scripts[0].word_count_total).toBe(146);
    expect(llm.reqs.map((r) => r.schemaName)).toEqual(['analysis', 'script_set']);
  });
  it('reports model failures without leaking keys', async () => {
    const res = await request(app(fakeLLM(new Error('bad key sk-test-secret-456')))).post('/api/intake').send({ platform: 'tiktok', text: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('sk-test');
  });
});

describe('teleprompter maths', () => {
  it('scrolls the whole text in the script duration, scaled by speed', () => {
    expect(scrollPxPerSecond(1200, 60, 1)).toBe(20);
    expect(scrollPxPerSecond(1200, 60, 1.5)).toBe(30);
    expect(scrollPxPerSecond(0, 60, 1)).toBe(0);
    expect(scrollPxPerSecond(1200, 0, 1)).toBe(0);
  });
  it('times each section from its word count at 2.5 words per second', () => {
    const t = timedSections(goodSet.scripts[0] as never);
    expect(t[0]).toMatchObject({ label: 'Hook', start: 0, end: 3.2, inWindow: true });
    expect(t[1]).toMatchObject({ label: 'Hold', start: 3.2, end: 14.4, inWindow: true });
    expect(t[2]!.inWindow).toBe(false);
    expect(t.at(-1)!.end).toBeCloseTo(58.4, 5);
  });
  it('splits [placeholders] out of spoken text', () => {
    expect(splitPlaceholders('It costs [your price] today.')).toEqual([
      { text: 'It costs ', placeholder: false },
      { text: '[your price]', placeholder: true },
      { text: ' today.', placeholder: false },
    ]);
    expect(splitPlaceholders('plain')).toEqual([{ text: 'plain', placeholder: false }]);
  });
  it('formats the clock and lists sections in spoken order', () => {
    expect(formatClock(75.9)).toBe('1:15');
    const labels = scriptSections(goodSet.scripts[0] as never).map((s) => s.label);
    expect(labels).toEqual(['Hook', 'Hold', 'Body 1', 'Body 2', 'Close']);
  });
});
