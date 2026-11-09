import type { Platform } from '../schemas/common';
import { Comment } from '../schemas/comment';
import { Video } from '../schemas/video';

/**
 * Raw Apify items -> our strict schemas. Built against real recorded samples (tests/fixtures).
 * Rules: unknown/invalid items are dropped (counted), missing signals become null (never 0),
 * and nothing identifying a person (username, name, avatar) is ever copied across.
 */

type Raw = Record<string, unknown>;

export interface NormalizeResult<T> {
  items: T[];
  dropped: number;
}

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Non-negative integer or null. Negative sentinels such as Instagram's hidden-likes -1 become null. */
const nonNeg = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
};

const MENTION = /@[\p{L}\p{N}._]+/gu;
/** Comment text may @mention people; replace handles so usernames never travel further. */
export const redactMentions = (text: string): string => text.replace(MENTION, '@user');

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const t of v) {
    const name = typeof t === 'string' ? t : isObj(t) ? str(t.name) : null;
    const clean = name?.replace(/^#/, '').trim().toLowerCase();
    if (clean) out.add(clean);
  }
  return [...out];
}

export function igShortCodeFromUrl(url: string | null): string | null {
  if (!url) return null;
  return /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/.exec(url)?.[1] ?? null;
}

export function tiktokIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  return /\/video\/(\d+)/.exec(url)?.[1] ?? null;
}

// ---------- videos ----------

export function normalizeIgReel(raw: unknown): Video | null {
  if (!isObj(raw)) return null;
  const shortCode = str(raw.shortCode);
  const views = nonNeg(raw.videoPlayCount) ?? nonNeg(raw.igPlayCount) ?? nonNeg(raw.videoViewCount);
  if (!shortCode || views === null) return null;
  if (raw.type !== undefined && raw.type !== 'Video') return null; // carousels / images have no spoken script

  const parsed = Video.safeParse({
    id: shortCode,
    platform: 'instagram',
    url: str(raw.url) ?? `https://www.instagram.com/reel/${shortCode}/`,
    caption: str(raw.caption) ?? '',
    hashtags: cleanTags(raw.hashtags),
    views,
    likes: nonNeg(raw.likesCount), // -1 (hidden) -> null
    comments: nonNeg(raw.commentsCount) ?? 0,
    shares: nonNeg(raw.sharesCount),
    saves: null,
    authorFollowers: null, // the Instagram actors do not provide it
    isPaid: raw.paidPartnership === true,
    publishedAt: str(raw.timestamp),
    durationSec: nonNeg(raw.videoDuration),
    transcript: str(raw.transcript),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeTikTokVideo(raw: unknown): Video | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const url = str(raw.webVideoUrl);
  const views = nonNeg(raw.playCount);
  if (!id || !url || views === null) return null;
  if (raw.isSlideshow === true) return null; // slideshows have no talking-to-camera script
  const authorMeta = isObj(raw.authorMeta) ? raw.authorMeta : {};
  const videoMeta = isObj(raw.videoMeta) ? raw.videoMeta : {};
  const duration = finite(videoMeta.duration);

  const parsed = Video.safeParse({
    id,
    platform: 'tiktok',
    url,
    caption: str(raw.text) ?? '',
    hashtags: cleanTags(raw.hashtags),
    views,
    likes: nonNeg(raw.diggCount),
    comments: nonNeg(raw.commentCount) ?? 0,
    shares: nonNeg(raw.shareCount),
    saves: nonNeg(raw.collectCount),
    authorFollowers: nonNeg(authorMeta.fans),
    isPaid: raw.isAd === true || raw.isSponsored === true,
    publishedAt: str(raw.createTimeISO),
    durationSec: duration !== null && duration >= 0 ? duration : null,
    transcript: null,
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeVideos(platform: Platform, rawItems: unknown[]): NormalizeResult<Video> {
  const fn = platform === 'instagram' ? normalizeIgReel : normalizeTikTokVideo;
  const seen = new Set<string>();
  const items: Video[] = [];
  for (const raw of rawItems) {
    const v = fn(raw);
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      items.push(v);
    }
  }
  return { items, dropped: rawItems.length - items.length };
}

/** Transcript from the Instagram reel-details actor (`includeTranscript`). */
export function normalizeIgTranscript(raw: unknown): { videoId: string; transcript: string } | null {
  if (!isObj(raw)) return null;
  const videoId = str(raw.shortCode);
  const transcript = str(raw.transcript);
  return videoId && transcript ? { videoId, transcript } : null;
}

// ---------- comments ----------

export function normalizeIgComment(raw: unknown): Comment | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const videoId = igShortCodeFromUrl(str(raw.postUrl));
  const text = str(raw.text);
  if (!id || !videoId || !text) return null;
  const parsed = Comment.safeParse({
    id,
    videoId,
    platform: 'instagram',
    text: redactMentions(text.trim()),
    likes: nonNeg(raw.likesCount) ?? 0,
    replyCount: nonNeg(raw.repliesCount),
    createdAt: str(raw.timestamp),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeTikTokComment(raw: unknown): Comment | null {
  if (!isObj(raw)) return null;
  const id = str(raw.cid);
  const videoId = tiktokIdFromUrl(str(raw.videoWebUrl) ?? str(raw.submittedVideoUrl));
  const text = str(raw.text);
  if (!id || !videoId || !text) return null;
  if (str(raw.repliesToId)) return null; // top-level comments only
  const parsed = Comment.safeParse({
    id,
    videoId,
    platform: 'tiktok',
    text: redactMentions(text.trim()),
    likes: nonNeg(raw.diggCount) ?? 0,
    replyCount: nonNeg(raw.replyCommentTotal),
    createdAt: str(raw.createTimeISO),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeComments(platform: Platform, rawItems: unknown[]): NormalizeResult<Comment> {
  const fn = platform === 'instagram' ? normalizeIgComment : normalizeTikTokComment;
  const seen = new Set<string>();
  const items: Comment[] = [];
  for (const raw of rawItems) {
    const c = fn(raw);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      items.push(c);
    }
  }
  return { items, dropped: rawItems.length - items.length };
}
