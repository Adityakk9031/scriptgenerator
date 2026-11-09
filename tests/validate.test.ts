import { describe, expect, it } from 'vitest';
import { computeBenchmarks } from '../src/pipeline/stats';
import { countWords, spokenText, validateScriptSet, type IssueCode, type ValidationContext } from '../src/pipeline/validate';
import type { Video } from '../src/schemas/video';

/** n unique pseudo-words in sentences of 8 words (so length/copy checks never trip by accident). */
function words(n: number, seed: string): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`${seed}${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);
  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i += 8) sentences.push(`${parts.slice(i, i + 8).join(' ')}.`);
  return sentences.join(' ');
}

const BENCH_VIDEOS: Video[] = [30_000, 45_000, 60_000, 120_000, 200_000].map((views, i) => ({
  id: `b${i}`, platform: 'tiktok', url: `https://www.tiktok.com/@u/video/${i}`, caption: '', hashtags: [], views,
  likes: Math.round(views * 0.04), comments: Math.round(views * 0.004), shares: Math.round(views * 0.002), saves: null,
  authorFollowers: null, isPaid: false, publishedAt: null, durationSec: 30, transcript: null,
}));
const benchmarks = computeBenchmarks(BENCH_VIDEOS); // median 60k, p75 120k, max 200k, like 4%, comment 0.4%, share 0.2%

const hookTypes = ['contrarian_claim', 'mistake_callout', 'number_result', 'curiosity_gap', 'direct_question', 'before_after'] as const;

interface Opts { hook?: number; hold?: number; body?: number[]; close?: number; hook_type?: (typeof hookTypes)[number]; benchmark?: string; profile?: string; on_screen_text?: string[]; hookText?: string; holdText?: string; bodyText?: string[]; closeText?: string }

function script(seed: string, o: Opts = {}) {
  const body = o.bodyText ?? (o.body ?? [45, 45]).map((n, k) => words(n, `${seed}b${k}`));
  return {
    label: `Script ${seed}`,
    hook_type: o.hook_type ?? 'contrarian_claim',
    segments: {
      hook: o.hookText ?? words(o.hook ?? 8, `${seed}h`),
      hold: o.holdText ?? words(o.hold ?? 28, `${seed}o`),
      body,
      close: o.closeText ?? words(o.close ?? 20, `${seed}c`),
    },
    on_screen_text: o.on_screen_text ?? ['one step not five'],
    word_count_total: 999, // deliberately wrong: the validator must recompute
    word_count_window: 999,
    est_seconds: 999,
    why_it_works: 'Top videos open with this pattern.',
    expected_response: {
      profile: o.profile ?? 'Tends to drive comments and saves.',
      benchmark: o.benchmark ?? 'Niche median is about 60k views, top quartile about 120k (estimate for this niche).',
    },
    best_for: 'Skeptical audiences',
    risk: 'Can feel preachy',
  };
}

const three = (overrides: Partial<Record<0 | 1 | 2, Opts>> = {}) => [
  script('a', { hook_type: hookTypes[0], ...overrides[0] }),
  script('b', { hook_type: hookTypes[1], ...overrides[1] }),
  script('c', { hook_type: hookTypes[2], ...overrides[2] }),
];
const setOf = (scripts: unknown[], assumptions: unknown[] = []) => ({ assumptions, scripts });
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ assumptions: [], benchmarks, sources: [], ...over });
const codes = (r: ReturnType<typeof validateScriptSet>, sev?: 'error' | 'warning'): IssueCode[] =>
  r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.code);

describe('countWords', () => {
  it('counts words, ignores bare punctuation, keeps hyphenated and apostrophe words as one', () => {
    expect(countWords("it's a well-known fix — really!")).toBe(5);
    expect(countWords('  ')).toBe(0);
    expect(countWords('a , . b')).toBe(2);
  });
});

describe('a well-formed set', () => {
  const r = validateScriptSet(setOf(three()), ctx());
  it('is valid with no errors', () => {
    expect(codes(r, 'error')).toEqual([]);
    expect(r.valid).toBe(true);
  });
  it('recomputes counts and seconds instead of trusting the model', () => {
    const s = r.set!.scripts[0]!;
    expect(s.word_count_window).toBe(36);
    expect(s.word_count_total).toBe(36 + 90 + 20);
    expect(s.est_seconds).toBe(58.4);
  });
});

describe('length rules', () => {
  const run = (o: Opts) => validateScriptSet(setOf(three({ 0: o })), ctx());
  it('hook over 10 words is an error', () => {
    expect(codes(run({ hook: 12, hold: 24 }), 'error')).toContain('hook_too_long');
    expect(codes(run({ hook: 10, hold: 26 }), 'error')).not.toContain('hook_too_long');
  });
  it('window: 31 error, 32 ok, 38 ok, 39-40 warning, 41 error', () => {
    expect(codes(run({ hook: 8, hold: 16 }), 'error')).toContain('window_too_short'); // 24
    const shortWarn = run({ hook: 8, hold: 23 }); // 31
    expect(codes(shortWarn, 'warning')).toContain('window_short_warn');
    expect(shortWarn.valid).toBe(true);
    expect(codes(run({ hook: 8, hold: 24 }))).not.toContain('window_too_short');
    expect(codes(run({ hook: 8, hold: 30 }))).toEqual([]); // 38
    const warn = run({ hook: 8, hold: 32, close: 18 }); // 40
    expect(codes(warn, 'warning')).toContain('window_long_warn');
    expect(warn.valid).toBe(true);
    expect(codes(run({ hook: 8, hold: 33, close: 18 }), 'error')).toContain('window_too_long'); // 41
  });
  it('total: 139 error, 140 ok, 155 ok, 156-160 warning, 161 error', () => {
    expect(codes(run({ body: [30, 33] }), 'error')).toContain('total_too_short'); // 36+63+20 = 119
    const shortTotal = run({ body: [45, 38] }); // 36+83+20 = 139
    expect(codes(shortTotal, 'warning')).toContain('total_short_warn');
    expect(shortTotal.valid).toBe(true);
    expect(codes(run({ body: [45, 39] }), 'error')).not.toContain('total_too_short'); // 140
    expect(codes(run({ body: [45, 54] }))).toEqual([]); // 155
    const warn = run({ body: [45, 55] }); // 156
    expect(codes(warn, 'warning')).toContain('total_long_warn');
    expect(warn.valid).toBe(true);
    expect(codes(run({ body: [45, 60] }), 'error')).toContain('total_too_long'); // 161
  });
  it('warns about overlong sentences without blocking the script', () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => `lw${i}`).join(' ') + '.';
    const warn = validateScriptSet(setOf(three({ 0: { bodyText: [long(14) + ' ' + words(76, 'x'), words(45, 'y')] } })), ctx());
    expect(codes(warn, 'warning')).toContain('sentence_long_warn');
    const err = validateScriptSet(setOf(three({ 0: { bodyText: [long(20) + ' ' + words(25, 'x'), words(45, 'y')] } })), ctx());
    expect(codes(err, 'warning')).toContain('sentence_too_long');
    expect(err.valid).toBe(true);
  });
});

describe('banned phrases and formatting', () => {
  const withBody = (text: string) => validateScriptSet(setOf(three({ 0: { bodyText: [text + ' ' + words(40, 'z'), words(45, 'y')] } })), ctx());
  it.each(['Hey guys welcome', 'This is a game-changer for you', 'It will unlock your skin', 'Unlocking results today', "Here's the thing about it", 'Here’s the thing about it', 'let me tell you something', 'Smash that button'])(
    'catches %j',
    (text) => {
      expect(codes(withBody(text), 'error')).toContain('banned_phrase');
    },
  );
  it('does not flag look-alike words', () => {
    expect(codes(withBody('The unlockable chest and a divine intervention.'), 'error')).not.toContain('banned_phrase');
  });
  it('catches emoji, hashtags and markdown in spoken text', () => {
    expect(codes(withBody('Love it 😍 so much.'), 'error')).toContain('emoji');
    expect(codes(withBody('Try #skincare today.'), 'error')).toContain('hashtag');
    expect(codes(withBody('This is **really** good.'), 'error')).toContain('markdown');
  });
  it('catches parenthetical and bracketed stage directions but allows [placeholders]', () => {
    expect(codes(withBody('Look here (points at product) now.'), 'error')).toContain('stage_direction');
    expect(codes(withBody('Now [smiles at camera] we begin.'), 'error')).toContain('stage_direction');
    const ok = withBody('It only costs [your price] today.');
    expect(codes(ok, 'error')).not.toContain('stage_direction');
    expect(ok.placeholders[0]).toEqual(['your price']);
  });
  it('catches guarantees and medical-style claims; warns on statistics', () => {
    expect(codes(withBody('Guaranteed results every time.'), 'error')).toContain('risky_claim');
    expect(codes(withBody('This cures breakouts forever.'), 'error')).toContain('risky_claim');
    const stat = withBody('Studies show it works for most people.');
    expect(codes(stat, 'warning')).toContain('unverified_stat');
    expect(stat.valid).toBe(true);
  });
  it('warns about long on-screen lines', () => {
    const r = validateScriptSet(setOf(three({ 0: { on_screen_text: ['this line has far too many words in it'] } })), ctx());
    expect(codes(r, 'warning')).toContain('on_screen_text_long');
  });
});

describe('copied text', () => {
  const phrase = 'the secret to glowing skin is simple';
  const own = (text: string) => validateScriptSet(setOf(three({ 0: { bodyText: [text + ' ' + words(40, 'z'), words(45, 'y')] } })), ctx({ sources: ['Totally different caption. ' + phrase + ' and then more words here.'] }));
  it('flags a run of 6+ identical words (case/punctuation-insensitive)', () => {
    expect(codes(own('Honestly, THE secret to glowing skin is simple!'), 'error')).toContain('copied_text');
  });
  it('allows a run of 5 words', () => {
    expect(codes(own('Honestly the secret to glowing skin.'), 'error')).not.toContain('copied_text');
  });
  it('ignores sources shorter than 6 words', () => {
    const r = validateScriptSet(setOf(three()), ctx({ sources: ['link please'] }));
    expect(r.valid).toBe(true);
  });
});

describe('variety across scripts', () => {
  it('flags a repeated hook_type', () => {
    const r = validateScriptSet(setOf(three({ 1: { hook_type: 'contrarian_claim' } })), ctx());
    const dup = r.issues.find((i) => i.code === 'duplicate_hook_type');
    expect(dup?.script).toBe(1);
  });
  it('flags near-identical scripts', () => {
    const a = script('a', { hook_type: hookTypes[0] });
    const b = { ...structuredClone(a), label: 'Copy', hook_type: hookTypes[1] };
    const r = validateScriptSet(setOf([a, b, script('c', { hook_type: hookTypes[2] })]), ctx());
    expect(r.issues.find((i) => i.code === 'too_similar')?.script).toBe(1);
  });
  it('warns when fewer than 3 scripts come back but stays valid', () => {
    const r = validateScriptSet(setOf(three().slice(0, 2)), ctx());
    expect(codes(r, 'warning')).toContain('few_scripts');
    expect(r.valid).toBe(true);
  });
});

describe('expected_response honesty', () => {
  const withBench = (benchmark: string, profile?: string) => validateScriptSet(setOf(three({ 0: { benchmark, ...(profile ? { profile } : {}) } })), ctx());
  it('accepts numbers that match the real benchmarks (rounded / formatted differently)', () => {
    expect(codes(withBench('Median ~60k views, top quartile 120,000, best 200k; comment rate 0.4%.'), 'error')).toEqual([]);
    expect(codes(withBench('Likes run about 4% of views and shares 0.2%.'), 'error')).toEqual([]);
  });
  it('rejects invented numbers', () => {
    expect(codes(withBench('Niche videos reach about 500k views.'), 'error')).toContain('unverified_number');
    expect(codes(withBench('Comment rate is typically 9%.'), 'error')).toContain('unverified_number');
  });
  it('ignores small plain numbers and percentile words', () => {
    expect(codes(withBench('Based on 5 videos; the top 25% reach about 120k views.'), 'error')).toEqual([]);
  });
  it('rejects promises or predictions of results', () => {
    expect(codes(withBench('This will get you 100k views.'), 'error')).toContain('view_promise');
    expect(codes(withBench('Likely to go viral.'), 'error')).toContain('view_promise');
    expect(codes(withBench('Median about 60k views.', 'We guarantee reach.'), 'error')).toContain('view_promise');
  });
  it('with no benchmarks available, any unit number is invented', () => {
    const empty = computeBenchmarks([]);
    const none = { benchmark: 'Benchmarks unavailable.' };
    const r = validateScriptSet(setOf(three({ 0: none, 1: none, 2: none })), ctx({ benchmarks: empty }));
    expect(codes(r, 'error')).toEqual([]);
    const bad = validateScriptSet(setOf(three({ 0: { benchmark: 'Typically 50k views.' } })), ctx({ benchmarks: empty }));
    expect(codes(bad, 'error')).toContain('unverified_number');
  });
});

describe('assumptions and schema', () => {
  it('overwrites the model\'s assumptions with the ones we actually made', () => {
    const modelSays = [{ field: 'audience', value: 'invented audience' }, { field: 'budget', value: 'invented budget' }];
    const ours = [{ field: 'budget' as const, value: 'mid-range, accessible price point' }];
    const r = validateScriptSet(setOf(three(), modelSays), ctx({ assumptions: ours }));
    expect(r.set!.assumptions).toEqual(ours);
  });
  it('reports a schema failure with no set', () => {
    const r = validateScriptSet({ scripts: 'nope' }, ctx());
    expect(r.valid).toBe(false);
    expect(r.set).toBeNull();
    expect(r.issues[0]).toMatchObject({ code: 'schema', script: null, severity: 'error' });
  });
  it('spokenText joins every spoken segment', () => {
    const s = validateScriptSet(setOf(three()), ctx()).set!.scripts[0]!;
    expect(countWords(spokenText(s))).toBe(s.word_count_total);
  });
});
