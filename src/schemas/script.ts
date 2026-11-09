import { z } from 'zod';
import { REQUIRED_BRIEF_FIELDS } from './brief';

/**
 * The LLM output contract (AGENT.md §5). snake_case on purpose: this is the JSON the model returns.
 * Shaped to stay compatible with OpenAI strict structured outputs (no records/maps; assumptions is an array).
 */
export const HOOK_TYPES = [
  'contrarian_claim',
  'number_result',
  'mistake_callout',
  'curiosity_gap',
  'direct_question',
  'before_after',
] as const;
export const HookType = z.enum(HOOK_TYPES);
export type HookType = z.infer<typeof HookType>;

export const ScriptSegments = z.strictObject({
  /** 0-3 s, <= 10 words. */
  hook: z.string().min(1),
  /** 3-15 s. Hook + hold = the engagement window (32-38 words). */
  hold: z.string().min(1),
  /** 15-50 s: 2-3 beats, each ending in a micro-hook where natural. */
  body: z.array(z.string().min(1)).min(2).max(3),
  /** 50-60 s: CTA or loop back to the hook. */
  close: z.string().min(1),
});

export const Script = z.strictObject({
  label: z.string().min(1),
  hook_type: HookType,
  segments: ScriptSegments,
  on_screen_text: z.array(z.string().min(1)).max(8),
  word_count_total: z.number().int().nonnegative(),
  word_count_window: z.number().int().nonnegative(),
  est_seconds: z.number().positive(),
  why_it_works: z.string().min(1),
  expected_response: z.strictObject({
    /** Relative profile: what this style tends to drive (views-reach / comments / saves / shares / replays). */
    profile: z.string().min(1),
    /** Benchmark taken from the scraped sample; always an estimate, never a promise. */
    benchmark: z.string().min(1),
  }),
  best_for: z.string().min(1),
  risk: z.string().min(1),
});
export type Script = z.infer<typeof Script>;

export const Assumption = z.strictObject({
  field: z.enum(REQUIRED_BRIEF_FIELDS),
  value: z.string().min(1),
});

export const ScriptSet = z.strictObject({
  assumptions: z.array(Assumption),
  scripts: z.array(Script).min(2).max(3),
});
export type ScriptSet = z.infer<typeof ScriptSet>;
