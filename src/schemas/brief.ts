import { z } from 'zod';
import { Platform } from './common';

export const FieldStatus = z.enum(['clear', 'vague', 'missing']);
export type FieldStatus = z.infer<typeof FieldStatus>;

/** One piece of the user's brief plus how well the user actually specified it. */
export const BriefField = z
  .strictObject({ value: z.string().nullable(), status: FieldStatus })
  .refine((f) => f.status !== 'missing' || f.value === null, {
    message: 'a missing field must have value = null',
  })
  .refine((f) => f.status === 'missing' || (f.value !== null && f.value.trim() !== ''), {
    message: 'a clear/vague field must have a non-empty value',
  });
export type BriefField = z.infer<typeof BriefField>;

/** Required brief fields in the priority order follow-up questions are asked (AGENT.md §6). */
export const REQUIRED_BRIEF_FIELDS = ['audience', 'product', 'topic', 'budget'] as const;
export type RequiredBriefField = (typeof REQUIRED_BRIEF_FIELDS)[number];

export const Goal = z.enum(['promote', 'educate', 'entertain', 'unknown']);

export const Brief = z.strictObject({
  platform: Platform,
  rawText: z.string().min(1),
  topic: BriefField,
  product: BriefField,
  audience: BriefField,
  budget: BriefField,
  goal: Goal,
  tone: z.string().nullable(),
  /** Search hashtags WITHOUT the leading '#'. */
  hashtags: z.array(z.string().regex(/^[^#\s]+$/, 'no "#" and no spaces')).max(10),
  keywords: z.array(z.string().min(1)).max(10),
});
export type Brief = z.infer<typeof Brief>;
