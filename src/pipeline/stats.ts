import type { Video } from '../schemas/video';

/** Quantile with linear interpolation (the common "type 7" definition). null for an empty list. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const median = (values: number[]): number | null => quantile(values, 0.5);

export interface Benchmarks {
  /** Organic videos in the sample. */
  sampleSize: number;
  views: { median: number; p75: number; max: number } | null;
  /** Median per-video rates (signal / views), over videos where the signal is known. null = not available. */
  likeRate: number | null;
  commentRate: number | null;
  shareRate: number | null;
  medianDurationSec: number | null;
}

/** Niche benchmarks for the honest "what to expect" estimate. Call with organic videos only. */
export function computeBenchmarks(videos: Video[]): Benchmarks {
  const withViews = videos.filter((v) => v.views > 0);
  const rateOf = (pick: (v: Video) => number | null): number | null =>
    median(withViews.flatMap((v) => (pick(v) === null ? [] : [(pick(v) as number) / v.views])));
  const views = videos.map((v) => v.views);

  return {
    sampleSize: videos.length,
    views:
      videos.length === 0
        ? null
        : { median: median(views) as number, p75: quantile(views, 0.75) as number, max: Math.max(...views) },
    likeRate: rateOf((v) => v.likes),
    commentRate: rateOf((v) => v.comments),
    shareRate: rateOf((v) => v.shares),
    medianDurationSec: median(videos.flatMap((v) => (v.durationSec === null ? [] : [v.durationSec]))),
  };
}
