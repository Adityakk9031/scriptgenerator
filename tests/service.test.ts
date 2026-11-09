import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskCache } from '../src/apify/cache';
import { LIMITS, perTagLimit } from '../src/apify/inputs';
import type { ApifyRunner, RunOptions } from '../src/apify/runner';
import { fetchComments, fetchVideos, type ApifyDeps } from '../src/apify/service';
import { parseEnv } from '../src/config/env';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = (name: string): Item[] => JSON.parse(readFileSync(path.resolve('tests', 'fixtures', `${name}.json`), 'utf8'));

const config = parseEnv({ APIFY_TOKEN: 'apify_test_token_123', OPENAI_API_KEY: 'sk-test-secret-456' });

interface Call {
  actorId: string;
  input: Record<string, unknown>;
  opts: RunOptions;
}

let dir: string;
let calls: Call[];
let deps: ApifyDeps;

/** Fake runner: returns canned raw items per actor id and records every paid call. */
function makeDeps(responses: Record<string, Item[]>): ApifyDeps {
  calls = [];
  const runner: ApifyRunner = {
    async run(actorId, input, opts) {
      calls.push({ actorId, input, opts });
      return (responses[actorId] ?? []).slice(0, opts.maxItems);
    },
  };
  return { runner, cache: createDiskCache(dir), actors: config.actors };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'scriptgen-svc-'));
  deps = makeDeps({
    [config.actors.instagramDiscovery]: fx('ig-discovery'),
    [config.actors.tiktokVideos]: fx('tiktok-videos'),
    [config.actors.instagramComments]: fx('ig-comments'),
    [config.actors.tiktokComments]: fx('tiktok-comments'),
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('perTagLimit', () => {
  it('splits the total across hashtags, rounding up, minimum 1', () => {
    expect(perTagLimit(50, 2)).toBe(25);
    expect(perTagLimit(50, 3)).toBe(17);
    expect(perTagLimit(50, 0)).toBe(50);
    expect(perTagLimit(1, 5)).toBe(1);
  });
});

describe('fetchVideos', () => {
  it('fetches Instagram reels with the discovery actor in reels mode', async () => {
    const r = await fetchVideos(deps, { platform: 'instagram', hashtags: ['skincare'] });
    expect(r.videos).toHaveLength(5);
    expect(r.cached).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actorId).toBe('apify/instagram-hashtag-scraper');
    expect(calls[0]!.input).toMatchObject({ hashtags: ['skincare'], resultsType: 'reels', resultsLimit: 50 });
  });

  it('fetches TikTok videos and flags ads', async () => {
    const r = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    expect(r.videos).toHaveLength(5);
    expect(r.videos.filter((v) => v.isPaid).length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.input).toMatchObject({ hashtags: ['skincare'], resultsPerPage: 50 });
  });

  it('serves the second identical request from cache with zero paid calls', async () => {
    await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    const again = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    expect(again.cached).toBe(true);
    expect(again.videos).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('normalizes hashtags (strip #, lowercase, dedupe) so equivalent requests share a cache entry', async () => {
    await fetchVideos(deps, { platform: 'instagram', hashtags: ['#SkinCare', 'skincare'] });
    const again = await fetchVideos(deps, { platform: 'instagram', hashtags: ['skincare'] });
    expect(calls).toHaveLength(1);
    expect(again.cached).toBe(true);
    expect(calls[0]!.input).toMatchObject({ hashtags: ['skincare'] });
  });

  it('splits the limit across hashtags and passes the cap to the runner', async () => {
    await fetchVideos(deps, { platform: 'instagram', hashtags: ['a', 'b'], limit: 20 });
    expect(calls[0]!.input).toMatchObject({ resultsLimit: 10 });
    expect(calls[0]!.opts.maxItems).toBe(20);
  });

  it('rejects an empty hashtag list without calling Apify', async () => {
    await expect(fetchVideos(deps, { platform: 'instagram', hashtags: [] })).rejects.toThrow('hashtag');
    await expect(fetchVideos(deps, { platform: 'instagram', hashtags: ['#', '  '] })).rejects.toThrow('hashtag');
    expect(calls).toHaveLength(0);
  });

  it('does not cache a failed run', async () => {
    const failing: ApifyDeps = {
      ...deps,
      runner: {
        run: async () => {
          throw new Error('Actor failed');
        },
      },
    };
    await expect(fetchVideos(failing, { platform: 'tiktok', hashtags: ['x'] })).rejects.toThrow('Actor failed');
    const ok = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['x'] });
    expect(ok.cached).toBe(false);
  });
});

describe('fetchComments', () => {
  it('fetches TikTok comments for the top videos only and links them to their video', async () => {
    const { videos } = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    calls.length = 0;
    const r = await fetchComments(deps, { platform: 'tiktok', videos });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actorId).toBe('clockworks/tiktok-comments-scraper');
    expect(calls[0]!.input).toMatchObject({ commentsPerPost: LIMITS.ttCommentsPerVideo });
    expect((calls[0]!.input.postURLs as string[]).length).toBe(LIMITS.topVideosForComments);
    expect(calls[0]!.opts.maxItems).toBe(LIMITS.ttCommentsPerVideo * LIMITS.topVideosForComments);
    expect(r.comments).toHaveLength(10);
    expect(r.comments.every((c) => c.videoId === videos[0]!.id)).toBe(true);
  });

  it('fetches Instagram comments the same way', async () => {
    const { videos } = await fetchVideos(deps, { platform: 'instagram', hashtags: ['skincare'] });
    calls.length = 0;
    const r = await fetchComments(deps, { platform: 'instagram', videos });
    expect(calls[0]!.actorId).toBe('apify/instagram-comment-scraper');
    expect(calls[0]!.input).toMatchObject({ resultsLimit: LIMITS.igCommentsPerVideo });
    expect(r.comments).toHaveLength(10);
  });

  it('enforces the per-video comment cap even if the actor returns more', async () => {
    const { videos } = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    const r = await fetchComments(deps, { platform: 'tiktok', videos, perVideo: 3 });
    expect(r.comments).toHaveLength(3);
    expect(calls.at(-1)!.opts.maxItems).toBe(3 * LIMITS.topVideosForComments);
  });

  it('ignores comments that belong to videos we did not ask about', async () => {
    const { videos } = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    const stranger = fx('tiktok-comments').map((c) => ({ ...c, videoWebUrl: 'https://www.tiktok.com/@x/video/999' }));
    const deps2 = makeDeps({ [config.actors.tiktokComments]: stranger });
    const r = await fetchComments(deps2, { platform: 'tiktok', videos });
    expect(r.comments).toHaveLength(0);
  });

  it('returns nothing and makes no paid call when there are no videos', async () => {
    const r = await fetchComments(deps, { platform: 'tiktok', videos: [] });
    expect(r.comments).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('caches comment scrapes too', async () => {
    const { videos } = await fetchVideos(deps, { platform: 'tiktok', hashtags: ['skincare'] });
    await fetchComments(deps, { platform: 'tiktok', videos });
    const again = await fetchComments(deps, { platform: 'tiktok', videos });
    expect(again.cached).toBe(true);
    expect(calls.filter((c) => c.actorId === config.actors.tiktokComments)).toHaveLength(1);
  });
});
