import { z } from 'zod';
import { NonNegInt, Platform } from './common';

/**
 * Normalized comment. Privacy: there is intentionally NO username/handle/avatar field,
 * and the schema is strict, so a normalizer that forgets to strip them fails validation.
 */
export const Comment = z.strictObject({
  id: z.string().min(1),
  videoId: z.string().min(1),
  platform: Platform,
  text: z.string().min(1),
  likes: NonNegInt,
  replyCount: NonNegInt.nullable(),
  createdAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Comment = z.infer<typeof Comment>;
