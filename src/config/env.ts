import dotenv from 'dotenv';
import { z } from 'zod';

/** Required secrets. Values are never logged or put into error messages. */
const REQUIRED_KEYS = ['APIFY_TOKEN', 'OPENAI_API_KEY'] as const;

export class EnvError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Fill them in the .env file (see .env.example).',
    );
    this.name = 'EnvError';
    this.missing = missing;
  }
}

/** Treat empty / whitespace-only strings as "not set" so defaults apply. */
const blankToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v;

const withDefault = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));

// Defaults are starting points; model IDs / actor IDs change over time, so every one is overridable.
const optionalSchema = z.object({
  OPENAI_MODEL_ANALYZE: withDefault('gpt-5.4-nano'),
  OPENAI_MODEL_GENERATE: withDefault('gpt-5.4-mini'),
  // Instagram topic discovery (hashtag/keyword -> reels). The reel-scraper below only takes usernames/URLs.
  APIFY_ACTOR_IG_DISCOVERY: withDefault('apify/instagram-hashtag-scraper'),
  // Instagram reel details for known reel URLs (shares count + built-in transcript options).
  APIFY_ACTOR_IG_REELS: withDefault('apify/instagram-reel-scraper'),
  APIFY_ACTOR_TIKTOK_VIDEOS: withDefault('clockworks/free-tiktok-scraper'),
  APIFY_ACTOR_IG_COMMENTS: withDefault('apify/instagram-comment-scraper'),
  APIFY_ACTOR_TIKTOK_COMMENTS: withDefault('clockworks/tiktok-comments-scraper'),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
});

export interface AppConfig {
  apifyToken: string;
  openaiApiKey: string;
  models: { analyze: string; generate: string };
  actors: {
    instagramDiscovery: string;
    instagramReels: string;
    tiktokVideos: string;
    instagramComments: string;
    tiktokComments: string;
  };
  port: number;
}

export function parseEnv(source: Record<string, string | undefined>): AppConfig {
  const missing = REQUIRED_KEYS.filter((k) => !source[k] || source[k]!.trim() === '');
  if (missing.length > 0) throw new EnvError([...missing]);

  const parsed = optionalSchema.safeParse(source);
  if (!parsed.success) {
    // Only report the names of the offending variables, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid environment variable(s): ${names.join(', ')}.`);
  }
  const o = parsed.data;

  return {
    apifyToken: source.APIFY_TOKEN!.trim(),
    openaiApiKey: source.OPENAI_API_KEY!.trim(),
    models: { analyze: o.OPENAI_MODEL_ANALYZE, generate: o.OPENAI_MODEL_GENERATE },
    actors: {
      instagramDiscovery: o.APIFY_ACTOR_IG_DISCOVERY,
      instagramReels: o.APIFY_ACTOR_IG_REELS,
      tiktokVideos: o.APIFY_ACTOR_TIKTOK_VIDEOS,
      instagramComments: o.APIFY_ACTOR_IG_COMMENTS,
      tiktokComments: o.APIFY_ACTOR_TIKTOK_COMMENTS,
    },
    port: o.PORT,
  };
}

/** Loads `.env` (if present) into process.env, then validates. */
export function loadEnv(): AppConfig {
  dotenv.config({ quiet: true });
  return parseEnv(process.env);
}
