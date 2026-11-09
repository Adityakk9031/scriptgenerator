import type { AppConfig } from '../config/env';
import type { Platform } from '../schemas/common';
import type { Comment } from '../schemas/comment';
import type { Video } from '../schemas/video';
import type { DiskCache } from './cache';
import {
  LIMITS,
  igCommentsInput,
  igDiscoveryInput,
  tiktokCommentsInput,
  tiktokVideosInput,
} from './inputs';
import { normalizeComments, normalizeVideos } from './normalize';
import type { ApifyRunner } from './runner';

export interface ApifyDeps {
  runner: ApifyRunner;
  cache: DiskCache;
  actors: AppConfig['actors'];
}

export interface FetchVideosResult {
  videos: Video[];
  dropped: number;
  /** true = served from the disk cache, so no Apify cost. */
  cached: boolean;
}

export interface FetchCommentsResult {
  comments: Comment[];
  dropped: number;
  cached: boolean;
}

/**
 * Job 1: top videos for a topic. Raw actor output is what gets cached, so improving a normalizer
 * later never forces a paid re-scrape.
 */
export async function fetchVideos(
  deps: ApifyDeps,
  params: { platform: Platform; hashtags: string[]; limit?: number },
): Promise<FetchVideosResult> {
  const hashtags = [...new Set(params.hashtags.map((h) => h.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))];
  if (hashtags.length === 0) throw new Error('At least one hashtag is required to search for videos.');
  const limit = params.limit ?? LIMITS.videos;

  const actorId = params.platform === 'instagram' ? deps.actors.instagramDiscovery : deps.actors.tiktokVideos;
  const input =
    params.platform === 'instagram' ? igDiscoveryInput(hashtags, limit) : tiktokVideosInput(hashtags, limit);

  const { data, cached } = await deps.cache.getOrFetch({ kind: 'videos', actorId, input, limit }, () =>
    deps.runner.run(actorId, input, { maxItems: limit }),
  );
  const { items, dropped } = normalizeVideos(params.platform, data);
  return { videos: items, dropped, cached };
}

/**
 * Job 2: comments for the best videos only (caller passes the already-scored top videos).
 * Comments are linked back to their video and capped per video.
 */
export async function fetchComments(
  deps: ApifyDeps,
  params: { platform: Platform; videos: Video[]; perVideo?: number },
): Promise<FetchCommentsResult> {
  const videos = params.videos.filter((v) => v.platform === params.platform).slice(0, LIMITS.topVideosForComments);
  if (videos.length === 0) return { comments: [], dropped: 0, cached: true };

  const perVideo =
    params.perVideo ?? (params.platform === 'instagram' ? LIMITS.igCommentsPerVideo : LIMITS.ttCommentsPerVideo);
  const urls = videos.map((v) => v.url);
  const actorId = params.platform === 'instagram' ? deps.actors.instagramComments : deps.actors.tiktokComments;
  const input = params.platform === 'instagram' ? igCommentsInput(urls, perVideo) : tiktokCommentsInput(urls, perVideo);
  const maxItems = perVideo * videos.length;

  const { data, cached } = await deps.cache.getOrFetch({ kind: 'comments', actorId, input, maxItems }, () =>
    deps.runner.run(actorId, input, { maxItems }),
  );

  const { items, dropped } = normalizeComments(params.platform, data);
  const wanted = new Set(videos.map((v) => v.id));
  const perVideoCount = new Map<string, number>();
  const comments: Comment[] = [];
  for (const c of items) {
    if (!wanted.has(c.videoId)) continue; // not one of the videos we asked about
    const n = perVideoCount.get(c.videoId) ?? 0;
    if (n >= perVideo) continue;
    perVideoCount.set(c.videoId, n + 1);
    comments.push(c);
  }
  return { comments, dropped: dropped + (items.length - comments.length), cached };
}
