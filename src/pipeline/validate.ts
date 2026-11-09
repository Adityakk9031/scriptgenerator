import type { Benchmarks } from './stats';
import {
  BANNED_PHRASES,
  HOOK_MAX_WORDS,
  MAX_COPIED_RUN_WORDS,
  MAX_SENTENCE_WORDS,
  SCRIPT_COUNT,
  TOTAL,
  WINDOW,
  estimateSeconds,
} from '../prompts/rules';
import { ScriptSet, type Script } from '../schemas/script';
import type { Assumption } from './followups';

/**
 * Code-side checks for generated scripts (AGENT.md §5). The model is asked to follow the rules, but nothing is
 * trusted: counts are recomputed, assumptions are overwritten, and everything below is verified here.
 * `error` issues block a script (and trigger the repair retry); `warning` issues are shown but do not block.
 */

export type IssueCode =
  | 'schema'
  | 'hook_too_long'
  | 'window_too_short'
  | 'window_short_warn'
  | 'total_short_warn'
  | 'window_too_long'
  | 'window_long_warn'
  | 'total_too_short'
  | 'total_too_long'
  | 'total_long_warn'
  | 'sentence_too_long'
  | 'sentence_long_warn'
  | 'banned_phrase'
  | 'emoji'
  | 'hashtag'
  | 'markdown'
  | 'stage_direction'
  | 'risky_claim'
  | 'unverified_stat'
  | 'copied_text'
  | 'duplicate_hook_type'
  | 'too_similar'
  | 'view_promise'
  | 'unverified_number'
  | 'on_screen_text_long'
  | 'few_scripts';

export interface ScriptIssue {
  /** 0-based script index, or null for problems with the whole response. */
  script: number | null;
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationContext {
  assumptions: Assumption[];
  benchmarks: Benchmarks;
  /** Scraped texts (captions, transcripts, comments, example openings) the scripts must not copy from. */
  sources: string[];
}

export interface ValidationResult {
  /** true when there are no error-level issues. */
  valid: boolean;
  issues: ScriptIssue[];
  /** Schema-valid response with recomputed counts and the given assumptions; null if it failed the schema. */
  set: ScriptSet | null;
  /** [square-bracket] placeholders the creator must fill in, per script. */
  placeholders: string[][];
}

// ---------- text helpers ----------

export const countWords = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export const spokenText = (s: Script): string => [s.segments.hook, s.segments.hold, ...s.segments.body, s.segments.close].join(' ');

const windowText = (s: Script): string => `${s.segments.hook} ${s.segments.hold}`;

const normalizeApostrophes = (t: string): string => t.replace(/[‘’]/g, "'");

/** Lowercase words with punctuation removed, for n-gram comparison. */
function wordsOf(text: string): string[] {
  return normalizeApostrophes(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BANNED_RES = BANNED_PHRASES.map((phrase) => ({
  phrase,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase)}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`, 'iu'),
}));

const STAGE_WORDS = /^(smile|laugh|pause|beat|point|look|show|zoom|cut|wave|nod|gesture|hold|sigh|whisper|b-?roll|text|overlay|on[- ]screen|music|sfx|transition)/i;
const RISKY_CLAIM = /\b(guarantee[sd]?|cure[sd]?|miracle|100%\s+(works|results|effective)|permanent(ly)?|clinically proven|doctor[- ]approved|overnight results?)\b/i;
const STAT_CLAIM = /(\d+(\.\d+)?\s*%|\b(studies show|research shows|according to (a )?(study|studies|research)|scientists (say|found))\b)/i;
const VIEW_PROMISE = /\b(guarantee[sd]?|will (get|hit|reach|earn|go viral)|going to (get|hit|go viral)|you(?:'ll| will) (get|hit|reach)|go(es)? viral|promise)\b/i;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// ---------- benchmark number checking ----------

interface AllowedNumbers {
  counts: number[]; // views etc.
  percents: number[];
}

function allowedNumbers(b: Benchmarks): AllowedNumbers {
  const counts: number[] = [b.sampleSize];
  if (b.views) counts.push(b.views.median, b.views.p75, b.views.max);
  const percents = [b.likeRate, b.commentRate, b.shareRate].flatMap((r) => (r === null ? [] : [r * 100]));
  return { counts, percents };
}

const near = (value: number, allowed: number[], relTol: number, absTol = 0): boolean =>
  allowed.some((a) => Math.abs(value - a) <= Math.max(absTol, Math.abs(a) * relTol));

/** Numbers with a k / M / % unit (or plain numbers >= 1000) in the benchmark sentence that match nothing in the real benchmarks. */
function unverifiedNumbers(text: string, b: Benchmarks): string[] {
  const allowed = allowedNumbers(b);
  const hasBenchmarks = b.sampleSize > 0 && b.views !== null;
  const bad: string[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|%)?(?![\p{L}\p{N}])/giu)) {
    const raw = m[1]!.replace(/,/g, '');
    let value = parseFloat(raw);
    const unit = (m[2] ?? '').toLowerCase();
    if (Number.isNaN(value)) continue;
    if (unit === '%') {
      if ([10, 25, 50, 75, 90, 95].includes(value)) continue; // "top 25%" style percentiles
      if (!hasBenchmarks || !near(value, allowed.percents, 0.08, 0.15)) bad.push(m[0].trim());
      continue;
    }
    if (unit === 'k') value *= 1_000;
    else if (unit === 'm') value *= 1_000_000;
    else if (value < 1000) continue; // small plain numbers ("3 videos") are not claims
    if (!hasBenchmarks || !near(value, allowed.counts, 0.08)) bad.push(m[0].trim());
  }
  return bad;
}

// ---------- the validator ----------

const issue = (script: number | null, code: IssueCode, severity: 'error' | 'warning', message: string): ScriptIssue => ({ script, code, severity, message });

function validateOne(s: Script, i: number, ctx: ValidationContext, sourceGrams: Set<string>): { issues: ScriptIssue[]; placeholders: string[] } {
  const out: ScriptIssue[] = [];
  const tag = `Script ${i + 1}`;
  const spoken = spokenText(s);
  const norm = normalizeApostrophes(spoken);

  // --- length ---
  const hook = countWords(s.segments.hook);
  const win = countWords(windowText(s));
  const total = countWords(spoken);
  if (hook > HOOK_MAX_WORDS) out.push(issue(i, 'hook_too_long', 'error', `${tag}: the hook has ${hook} words; it must be at most ${HOOK_MAX_WORDS}.`));
  if (win < WINDOW.blockBelowWords) out.push(issue(i, 'window_too_short', 'error', `${tag}: hook + hold has ${win} words; the first ${WINDOW.seconds} seconds need ${WINDOW.minWords}-${WINDOW.maxWords}.`));
  else if (win < WINDOW.minWords) out.push(issue(i, 'window_short_warn', 'warning', `${tag}: hook + hold has ${win} words (target ${WINDOW.minWords}-${WINDOW.maxWords}).`));
  else if (win > WINDOW.hardCapWords) out.push(issue(i, 'window_too_long', 'error', `${tag}: hook + hold has ${win} words; it must not exceed ${WINDOW.hardCapWords} (target ${WINDOW.minWords}-${WINDOW.maxWords}).`));
  else if (win > WINDOW.maxWords) out.push(issue(i, 'window_long_warn', 'warning', `${tag}: hook + hold has ${win} words (target ${WINDOW.minWords}-${WINDOW.maxWords}); it may run slightly past ${WINDOW.seconds} seconds.`));
  if (total < TOTAL.blockBelowWords) out.push(issue(i, 'total_too_short', 'error', `${tag}: the script has ${total} words; it needs ${TOTAL.minWords}-${TOTAL.maxWords} for about ${TOTAL.seconds} seconds.`));
  else if (total < TOTAL.minWords) out.push(issue(i, 'total_short_warn', 'warning', `${tag}: the script has ${total} words (target ${TOTAL.minWords}-${TOTAL.maxWords}); it will run a little under ${TOTAL.seconds} seconds.`));
  else if (total > TOTAL.hardCapWords) out.push(issue(i, 'total_too_long', 'error', `${tag}: the script has ${total} words; it must not exceed ${TOTAL.hardCapWords} (target ${TOTAL.minWords}-${TOTAL.maxWords}).`));
  else if (total > TOTAL.maxWords) out.push(issue(i, 'total_long_warn', 'warning', `${tag}: the script has ${total} words (target ${TOTAL.minWords}-${TOTAL.maxWords}); it may run a little over ${TOTAL.seconds} seconds.`));

  // --- sentence length (must be easy to say in one breath) ---
  for (const sentence of splitSentences(spoken)) {
    const w = countWords(sentence);
    if (w > MAX_SENTENCE_WORDS + 6) out.push(issue(i, 'sentence_too_long', 'warning', `${tag}: a sentence has ${w} words ("${sentence.slice(0, 60)}..."); keep sentences to ${MAX_SENTENCE_WORDS} words or fewer.`));
    else if (w > MAX_SENTENCE_WORDS) out.push(issue(i, 'sentence_long_warn', 'warning', `${tag}: a sentence has ${w} words; shorter is easier to say.`));
  }

  // --- banned phrases ---
  for (const { phrase, re } of BANNED_RES) {
    if (re.test(norm)) out.push(issue(i, 'banned_phrase', 'error', `${tag}: uses the banned phrase "${phrase}".`));
  }

  // --- formatting that must not be spoken ---
  if (/\p{Extended_Pictographic}/u.test(spoken)) out.push(issue(i, 'emoji', 'error', `${tag}: the spoken text contains an emoji.`));
  if (/#[\p{L}\p{N}_]+/u.test(spoken)) out.push(issue(i, 'hashtag', 'error', `${tag}: the spoken text contains a hashtag.`));
  if (/[*`~]|^\s*#|\s#{1,6}\s/m.test(spoken)) out.push(issue(i, 'markdown', 'error', `${tag}: the spoken text contains markdown formatting.`));
  if (/\([^)]*\)/.test(spoken)) out.push(issue(i, 'stage_direction', 'error', `${tag}: the spoken text contains a parenthetical (stage directions belong in on_screen_text).`));
  const placeholders: string[] = [];
  for (const m of spoken.matchAll(/\[([^\]]+)\]/g)) {
    const inner = m[1]!.trim();
    if (STAGE_WORDS.test(inner)) out.push(issue(i, 'stage_direction', 'error', `${tag}: "[${inner}]" looks like a stage direction; only [placeholders] for facts the creator must supply are allowed.`));
    else placeholders.push(inner);
  }

  // --- honesty ---
  const risky = RISKY_CLAIM.exec(spoken);
  if (risky) out.push(issue(i, 'risky_claim', 'error', `${tag}: makes a guarantee / medical-style claim ("${risky[0]}"). Remove it.`));
  const stat = STAT_CLAIM.exec(spoken);
  if (stat) out.push(issue(i, 'unverified_stat', 'warning', `${tag}: contains a statistic ("${stat[0]}"); make sure the creator can back it up.`));

  // --- copied text: no run of more than MAX_COPIED_RUN_WORDS identical words from any source ---
  const n = MAX_COPIED_RUN_WORDS + 1;
  const mine = wordsOf(spoken);
  for (let k = 0; k + n <= mine.length; k++) {
    const gram = mine.slice(k, k + n).join(' ');
    if (sourceGrams.has(gram)) {
      out.push(issue(i, 'copied_text', 'error', `${tag}: copies more than ${MAX_COPIED_RUN_WORDS} words in a row from a source ("${gram}"). Rewrite it in new words.`));
      break;
    }
  }

  // --- expected_response honesty ---
  const bench = s.expected_response.benchmark;
  const combined = `${s.expected_response.profile} ${bench}`;
  if (VIEW_PROMISE.test(combined)) out.push(issue(i, 'view_promise', 'error', `${tag}: expected_response promises or predicts results; describe the niche benchmark as an estimate only.`));
  const bad = unverifiedNumbers(bench, ctx.benchmarks);
  if (bad.length > 0) out.push(issue(i, 'unverified_number', 'error', `${tag}: expected_response.benchmark uses numbers that are not in the supplied niche benchmarks (${bad.join(', ')}). Use only the supplied numbers.`));

  // --- on-screen text ---
  for (const line of s.on_screen_text) {
    if (countWords(line) > 6) out.push(issue(i, 'on_screen_text_long', 'warning', `${tag}: on-screen line "${line}" is longer than 6 words.`));
  }

  return { issues: out, placeholders };
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

export const SIMILARITY_LIMIT = 0.55;

export function validateScriptSet(raw: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = ScriptSet.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 4).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    return { valid: false, set: null, placeholders: [], issues: [issue(null, 'schema', 'error', `The response did not match the required format (${detail}).`)] };
  }

  const sourceGrams = new Set<string>();
  for (const src of ctx.sources) for (const g of ngrams(wordsOf(src), MAX_COPIED_RUN_WORDS + 1)) sourceGrams.add(g);

  const issues: ScriptIssue[] = [];
  const placeholders: string[][] = [];
  const scripts = parsed.data.scripts.map((s, i) => {
    const r = validateOne(s, i, ctx, sourceGrams);
    issues.push(...r.issues);
    placeholders.push(r.placeholders);
    // never trust the model's own numbers
    const total = countWords(spokenText(s));
    return { ...s, word_count_total: total, word_count_window: countWords(windowText(s)), est_seconds: estimateSeconds(total) };
  });

  // --- across scripts ---
  if (scripts.length < SCRIPT_COUNT) issues.push(issue(null, 'few_scripts', 'warning', `Only ${scripts.length} scripts were returned (target ${SCRIPT_COUNT}).`));
  const seenHooks = new Map<string, number>();
  scripts.forEach((s, i) => {
    const first = seenHooks.get(s.hook_type);
    if (first !== undefined) issues.push(issue(i, 'duplicate_hook_type', 'error', `Script ${i + 1} uses the same hook_type ("${s.hook_type}") as script ${first + 1}; each script needs a different hook_type and angle.`));
    else seenHooks.set(s.hook_type, i);
  });
  const sets = scripts.map((s) => new Set(wordsOf(spokenText(s))));
  for (let i = 1; i < scripts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (jaccard(sets[i]!, sets[j]!) > SIMILARITY_LIMIT) {
        issues.push(issue(i, 'too_similar', 'error', `Script ${i + 1} is too similar to script ${j + 1}; write a genuinely different angle in different words.`));
        break;
      }
    }
  }

  return {
    valid: !issues.some((x) => x.severity === 'error'),
    issues,
    placeholders,
    // assumptions are overwritten with the ones we actually made, so the model cannot add or drop any
    set: { assumptions: ctx.assumptions.map((a) => ({ field: a.field, value: a.value })), scripts },
  };
}
