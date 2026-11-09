import { z } from 'zod';
import { NonNegInt, Platform } from './common';

/**
 * Normalized short video (Reel / TikTok), independent of which Apify actor produced it.
 * Strict on purpose: unknown keys (e.g. author handles) are rejected, not silently kept.
 */
export const Video = z.strictObject({
  id: z.string().min(1),
  platform: Platform,
  url: z.url(),
  caption: z.string(),
  /** Without the leading '#'. */
  hashtags: z.array(z.string()),
  views: NonNegInt,
  /** null = hidden by the creator (Instagram returns -1 for some reels). */
  likes: NonNegInt.nullable(),
  comments: NonNegInt,
  /** null = the source did not provide it. */
  shares: NonNegInt.nullable(),
  saves: NonNegInt.nullable(),
  /** TikTok provides it; the Instagram actors do not (null). */
  authorFollowers: NonNegInt.nullable(),
  /** Ad / sponsored / paid partnership. Excluded from organic benchmarks. */
  isPaid: z.boolean(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  durationSec: z.number().nonnegative().nullable(),
  /** Spoken transcript, filled only for the top videos. */
  transcript: z.string().nullable(),
});
export type Video = z.infer<typeof Video>;
