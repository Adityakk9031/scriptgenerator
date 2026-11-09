/**
 * Single source of truth for the script rules in AGENT.md §5.
 * The generate prompt interpolates these constants and the validator (step 7) enforces the same ones,
 * so the prompt and the checks cannot drift apart.
 */

/** Spoken pace used to turn words into seconds. */
export const WORDS_PER_SECOND = 2.5;

export const SCRIPT_COUNT = 3;

/** Hook: seconds 0-3. */
export const HOOK_SECONDS = 3;
export const HOOK_MAX_WORDS = 10;

/** Engagement window = hook + hold = seconds 0-15. Must work standalone. */
export const WINDOW = { seconds: 15, minWords: 32, maxWords: 38, hardCapWords: 40, blockBelowWords: 25 } as const;

/** Whole script ~60 s. */
export const TOTAL = { seconds: 60, minWords: 140, maxWords: 155, hardCapWords: 160, blockBelowWords: 120 } as const;

/** Body beats between second 15 and 50. */
export const BODY_BEATS = { min: 2, max: 3 } as const;
export const BODY_SECONDS = { from: 15, to: 50 } as const;

/** A single spoken sentence should stay short enough to say in one breath. */
export const MAX_SENTENCE_WORDS = 12;

/** No run of more than this many identical words may be copied from any source caption/transcript/comment. */
export const MAX_COPIED_RUN_WORDS = 5;

/** Clichés and filler that make a script sound written or generic. Matched case-insensitively on word boundaries. */
export const BANNED_PHRASES = [
  "in today's fast-paced world",
  'let me tell you',
  'game-changer',
  'game changer',
  'unlock',
  'dive into',
  "here's the thing",
  'hey guys',
  'hey everyone',
  'welcome back',
  'in this video',
  'like and subscribe',
  'smash that',
  "don't forget to",
] as const;

export const estimateSeconds = (words: number): number => Math.round((words / WORDS_PER_SECOND) * 10) / 10;
