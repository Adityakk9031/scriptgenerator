import type { Video } from '../schemas/video';
import { computeBenchmarks, median, type Benchmarks } from './stats';

/**
 * Reel Score: how much a video is worth learning from.
 *   score = 0.35·views + 0.30·engagement + 0.20·outlier + 0.15·recency
 * Each component is in [0, 1]. A component that cannot be computed (null) is skipped and the remaining
 * weights are renormalised, so hidden likes / missing follower counts never count as zero.
 */
export const SCORE_WEIGHTS = { views: 0.35, engagement: 0.3, outlier: 0.2, recency: 0.15 } as const;
export type ScoreWeights = { [K in keyof typeof SCORE_WEIGHTS]: number };

/** Engagement signals and how much each counts (shares drive reach, so they weigh most). */
export const ENGAGEMENT_SIGNAL_WEIGHTS = { likes: 1, comments: 2, shares: 3 } as const;
export const RECENCY_HALF_LIFE_DAYS = 30;
/** Below this a video is treated as noise and not learned from. */
export const MIN_VIEWS = 500;
export const DEFAULT_TOP_N = 15;

const DAY_MS = 86_400_000;
const OUTLIER_CAP = 100; // views/followers above this are treated as 100
const REL_CAP = 10; // a signal can count at most 10x the sample median

/** x/(x+1): maps [0, inf) to [0, 1) with 1 -> 0.5, so "typical" lands mid-scale. */
const squash = (x: number): number => x / (x + 1);

export interface ScoreComponents {
  views: number;
  engagement: number;
  outlier: number | null;
  recency: number | null;
}

export interface ScoredVideo {
  video: Video;
  score: number;
  components: ScoreComponents;
}

function viewsComponents(videos: Video[]): Map<string, number> {
  const logs = videos.map((v) => Math.log10(v.views + 1));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  return new Map(videos.map((v, i) => [v.id, hi === lo ? 0.5 : (logs[i]! - lo) / (hi - lo)]));
}

/**
 * Per-signal rate (signal / views) relative to the sample's typical rate for that signal,
 * averaged over only the signals this video actually has.
 */
function engagementComponents(videos: Video[]): Map<string, number> {
  const signals = Object.keys(ENGAGEMENT_SIGNAL_WEIGHTS) as (keyof typeof ENGAGEMENT_SIGNAL_WEIGHTS)[];
  const rate = (v: Video, s: (typeof signals)[number]): number | null => {
    const raw = s === 'likes' ? v.likes : s === 'comments' ? v.comments : v.shares;
    return raw === null || v.views <= 0 ? null : raw / v.views;
  };

  // reference rate per signal: sample median, falling back to the mean of positive rates, else unusable
  const reference = new Map<(typeof signals)[number], number>();
  for (const s of signals) {
    const rates = videos.flatMap((v) => (rate(v, s) === null ? [] : [rate(v, s) as number]));
    const med = median(rates);
    const positive = rates.filter((r) => r > 0);
    const ref = med !== null && med > 0 ? med : positive.length > 0 ? positive.reduce((a, b) => a + b, 0) / positive.length : null;
    if (ref !== null) reference.set(s, ref);
  }

  return new Map(
    videos.map((v) => {
      let weighted = 0;
      let weightSum = 0;
      for (const s of signals) {
        const r = rate(v, s);
        const ref = reference.get(s);
        if (r === null || ref === undefined) continue;
        const w = ENGAGEMENT_SIGNAL_WEIGHTS[s];
        weighted += w * Math.min(REL_CAP, r / ref);
        weightSum += w;
      }
      return [v.id, weightSum === 0 ? 0 : squash(weighted / weightSum)];
    }),
  );
}

const outlierOf = (v: Video): number | null =>
  v.authorFollowers !== null && v.authorFollowers > 0
    ? squash(Math.min(OUTLIER_CAP, v.views / v.authorFollowers))
    : null;

const recencyOf = (v: Video, now: Date): number | null => {
  if (!v.publishedAt) return null;
  const ageDays = (now.getTime() - Date.parse(v.publishedAt)) / DAY_MS;
  if (Number.isNaN(ageDays)) return null;
  return ageDays <= 0 ? 1 : Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
};

export function scoreVideos(
  videos: Video[],
  opts: { now?: Date; weights?: ScoreWeights } = {},
): ScoredVideo[] {
  if (videos.length === 0) return [];
  const now = opts.now ?? new Date();
  const weights = opts.weights ?? SCORE_WEIGHTS;
  const viewsC = viewsComponents(videos);
  const engC = engagementComponents(videos);

  return videos.map((video) => {
    const components: ScoreComponents = {
      views: viewsC.get(video.id) ?? 0,
      engagement: engC.get(video.id) ?? 0,
      outlier: outlierOf(video),
      recency: recencyOf(video, now),
    };
    let sum = 0;
    let wSum = 0;
    for (const key of Object.keys(weights) as (keyof ScoreWeights)[]) {
      const c = components[key];
      if (c === null) continue;
      sum += weights[key] * c;
      wSum += weights[key];
    }
    return { video, components, score: wSum === 0 ? 0 : sum / wSum };
  });
}

export interface RankResult {
  /** Best videos first, at most `topN`. Organic only. */
  ranked: ScoredVideo[];
  /** Niche benchmarks over ALL organic videos in the sample, not just the top ones. */
  benchmarks: Benchmarks;
  organicCount: number;
  paidExcluded: number;
  lowSignalDropped: number;
}

/** Drop ads and noise, score what is left, return the top N plus sample-wide benchmarks. */
export function rankVideos(
  videos: Video[],
  opts: { now?: Date; topN?: number; minViews?: number; weights?: ScoreWeights } = {},
): RankResult {
  const minViews = opts.minViews ?? MIN_VIEWS;
  const paidExcluded = videos.filter((v) => v.isPaid).length;
  const organic = videos.filter((v) => !v.isPaid);
  const usable = organic.filter((v) => v.views >= minViews);

  const scored = scoreVideos(usable, opts)
    .sort((a, b) => b.score - a.score || b.video.views - a.video.views || a.video.id.localeCompare(b.video.id))
    .slice(0, opts.topN ?? DEFAULT_TOP_N);

  return {
    ranked: scored,
    benchmarks: computeBenchmarks(usable),
    organicCount: usable.length,
    paidExcluded,
    lowSignalDropped: organic.length - usable.length,
  };
}
