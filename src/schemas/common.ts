import { z } from 'zod';

export const Platform = z.enum(['instagram', 'tiktok']);
export type Platform = z.infer<typeof Platform>;

export const NonNegInt = z.number().int().nonnegative();
