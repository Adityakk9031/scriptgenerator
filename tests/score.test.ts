import { describe, expect, it } from 'vitest';
import {
  MIN_VIEWS,
  RECENCY_HALF_LIFE_DAYS,
  SCORE_WEIGHTS,
  rankVideos,
  scoreVideos,
} from '../src/pipeline/score';
import { computeBenchmarks, median, quantile } from '../src/pipeline/stats';
import type { Video } from '../src/schemas/video';

const NOW = new Date('2026-11-09T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let n = 0;
function vid(over: Partial<Video> = {}): Video {
  n++;
  return {
    id: `v${n}`,
    platform: 'tiktok',
    url: `https://www.tiktok.com/@u/video/${n}`,
    caption: 'c',
    hashtags: [],
    views: 100_000,
    likes: 5_000,
    comments: 300,
    shares: 200,
    saves: null,
    authorFollowers: 50_000,
    isPaid: false,
    publishedAt: daysAgo(5),
    durationSec: 30,
    transcript: null,
    ...over,
  };
}
const byId = (list: ReturnType<typeof scoreVideos>, v: Video) => list.find((s) => s.video.id === v.id)!;

describe('quantile / median', () => {
  it('computes known values', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([7], 0.9)).toBe(7);
  });
  it('returns null for an empty list and does not mutate input', () => {
    expect(median([])).toBeNull();
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('scoreVideos', () => {
  it('weights sum to 1', () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('returns [] for no videos and a single scored video for one', () => {
    expect(scoreVideos([], { now: NOW })).toEqual([]);
    const only = scoreVideos([vid()], { now: NOW });
    expect(only).toHaveLength(1);
    expect(only[0]!.components.views).toBe(0.5); // no spread -> mid
  });

  it('keeps every component and the score within [0, 1]', () => {
    const vs = [vid({ views: 1_000 }), vid({ views: 10_000_000, likes: null, shares: null }), vid({ authorFollowers: null, publishedAt: null })];
    for (const s of scoreVideos(vs, { now: NOW })) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      for (const c of Object.values(s.components)) if (c !== null) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('more views scores higher, all else equal', () => {
    const lo = vid({ views: 10_000, likes: 500, comments: 30, shares: 20 });
    const hi = vid({ views: 1_000_000, likes: 50_000, comments: 3_000, shares: 2_000 });
    const s = scoreVideos([lo, hi], { now: NOW });
    expect(byId(s, hi).score).toBeGreaterThan(byId(s, lo).score);
  });

  it('a small account with the same views outscores a big account (outlier)', () => {
    const small = vid({ authorFollowers: 5_000 });
    const big = vid({ authorFollowers: 5_000_000 });
    const s = scoreVideos([small, big], { now: NOW });
    expect(byId(s, small).components.outlier!).toBeGreaterThan(byId(s, big).components.outlier!);
    expect(byId(s, small).score).toBeGreaterThan(byId(s, big).score);
  });

  it('higher engagement beats lower engagement at equal views', () => {
    const lively = vid({ comments: 3_000, shares: 2_000, likes: 9_000 });
    const quiet = vid({ comments: 30, shares: 20, likes: 500 });
    const s = scoreVideos([lively, quiet], { now: NOW });
    expect(byId(s, lively).components.engagement).toBeGreaterThan(byId(s, quiet).components.engagement);
  });

  it('shares count for more than likes', () => {
    const shareHeavy = vid({ likes: 1_000, shares: 4_000, comments: 300 });
    const likeHeavy = vid({ likes: 4_000, shares: 1_000, comments: 300 });
    const s = scoreVideos([shareHeavy, likeHeavy], { now: NOW });
    expect(byId(s, shareHeavy).components.engagement).toBeGreaterThan(byId(s, likeHeavy).components.engagement);
  });

  it('hidden likes (null) are skipped, not treated as zero', () => {
    const base = { likes: 5_000, comments: 300, shares: 200 };
    const a = vid(base);
    const b = vid({ ...base, likes: null });
    const c = vid(base);
    const s = scoreVideos([a, b, c], { now: NOW });
    expect(byId(s, b).components.engagement).toBeCloseTo(byId(s, a).components.engagement, 10);
  });

  it('null follower count -> outlier null and weights renormalise over the rest', () => {
    const noFollowers = vid({ authorFollowers: null, publishedAt: null });
    const other = vid({ views: 20_000 });
    const s = byId(scoreVideos([noFollowers, other], { now: NOW }), noFollowers);
    expect(s.components.outlier).toBeNull();
    expect(s.components.recency).toBeNull();
    const w = SCORE_WEIGHTS;
    const expected = (w.views * s.components.views + w.engagement * s.components.engagement) / (w.views + w.engagement);
    expect(s.score).toBeCloseTo(expected, 10);
  });

  it('recency halves every half-life and is null without a date', () => {
    const fresh = vid({ publishedAt: NOW.toISOString() });
    const old = vid({ publishedAt: daysAgo(RECENCY_HALF_LIFE_DAYS) });
    const older = vid({ publishedAt: daysAgo(RECENCY_HALF_LIFE_DAYS * 2) });
    const future = vid({ publishedAt: daysAgo(-3) });
    const undated = vid({ publishedAt: null });
    const s = scoreVideos([fresh, old, older, future, undated], { now: NOW });
    expect(byId(s, fresh).components.recency).toBeCloseTo(1, 10);
    expect(byId(s, old).components.recency).toBeCloseTo(0.5, 10);
    expect(byId(s, older).components.recency).toBeCloseTo(0.25, 10);
    expect(byId(s, future).components.recency).toBe(1);
    expect(byId(s, undated).components.recency).toBeNull();
  });

  it('custom weights change the ranking', () => {
    const viral = vid({ views: 5_000_000, authorFollowers: 4_000_000, publishedAt: daysAgo(90) });
    const fresh = vid({ views: 50_000, authorFollowers: 4_000_000, publishedAt: daysAgo(1) });
    const viewsOnly = { views: 1, engagement: 0, outlier: 0, recency: 0 };
    const recencyOnly = { views: 0, engagement: 0, outlier: 0, recency: 1 };
    const a = scoreVideos([viral, fresh], { now: NOW, weights: viewsOnly });
    const b = scoreVideos([viral, fresh], { now: NOW, weights: recencyOnly });
    expect(byId(a, viral).score).toBeGreaterThan(byId(a, fresh).score);
    expect(byId(b, fresh).score).toBeGreaterThan(byId(b, viral).score);
  });

  it('a single huge outlier does not crush everyone else to zero (log-scaled views)', () => {
    const vs = [vid({ views: 1_000 }), vid({ views: 10_000 }), vid({ views: 100_000 }), vid({ views: 100_000_000 })];
    const s = scoreVideos(vs, { now: NOW });
    expect(byId(s, vs[2]!).components.views).toBeGreaterThan(0.3);
  });
});

describe('rankVideos', () => {
  it('excludes paid videos, drops low-signal, sorts best first, and reports counts', () => {
    const good = vid({ views: 900_000 });
    const ok = vid({ views: 20_000 });
    const ad = vid({ views: 5_000_000, isPaid: true });
    const tiny = vid({ views: MIN_VIEWS - 1 });
    const r = rankVideos([ok, ad, tiny, good], { now: NOW });
    expect(r.ranked.map((x) => x.video.id)).toEqual([good.id, ok.id]);
    expect(r.paidExcluded).toBe(1);
    expect(r.lowSignalDropped).toBe(1);
    expect(r.organicCount).toBe(2);
  });

  it('respects topN', () => {
    const vs = Array.from({ length: 30 }, (_, i) => vid({ views: 1_000 + i * 1_000 }));
    expect(rankVideos(vs, { now: NOW }).ranked).toHaveLength(15);
    expect(rankVideos(vs, { now: NOW, topN: 5 }).ranked).toHaveLength(5);
  });

  it('breaks exact ties deterministically', () => {
    const a = vid({ id: 'a' });
    const b = vid({ id: 'b' });
    const ids1 = rankVideos([b, a], { now: NOW }).ranked.map((x) => x.video.id);
    const ids2 = rankVideos([a, b], { now: NOW }).ranked.map((x) => x.video.id);
    expect(ids1).toEqual(['a', 'b']);
    expect(ids2).toEqual(ids1);
  });

  it('handles empty and all-paid input without throwing', () => {
    expect(rankVideos([], { now: NOW }).ranked).toEqual([]);
    const r = rankVideos([vid({ isPaid: true })], { now: NOW });
    expect(r.ranked).toEqual([]);
    expect(r.paidExcluded).toBe(1);
    expect(r.benchmarks.sampleSize).toBe(0);
    expect(r.benchmarks.views).toBeNull();
  });

  it('computes benchmarks over the whole organic sample, not only the top N', () => {
    const vs = [100_000, 200_000, 300_000, 400_000, 500_000].map((views) => vid({ views }));
    const r = rankVideos(vs, { now: NOW, topN: 2 });
    expect(r.ranked).toHaveLength(2);
    expect(r.benchmarks.sampleSize).toBe(5);
    expect(r.benchmarks.views).toEqual({ median: 300_000, p75: 400_000, max: 500_000 });
  });
});

describe('computeBenchmarks', () => {
  it('computes median rates and skips unknown signals', () => {
    const vs = [
      vid({ views: 1_000, likes: 100, comments: 10, shares: 5, durationSec: 20 }),
      vid({ views: 1_000, likes: 200, comments: 20, shares: null, durationSec: 40 }),
      vid({ views: 1_000, likes: null, comments: 30, shares: 15, durationSec: null }),
    ];
    const b = computeBenchmarks(vs);
    expect(b.likeRate).toBeCloseTo(0.15, 10); // median of 0.1, 0.2
    expect(b.commentRate).toBeCloseTo(0.02, 10);
    expect(b.shareRate).toBeCloseTo(0.01, 10); // median of 0.005, 0.015
    expect(b.medianDurationSec).toBe(30);
  });
  it('returns null rates when no video has the signal', () => {
    const b = computeBenchmarks([vid({ likes: null, shares: null })]);
    expect(b.likeRate).toBeNull();
    expect(b.shareRate).toBeNull();
  });
});
