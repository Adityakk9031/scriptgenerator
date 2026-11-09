import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const load = (name: string): Item[] =>
  JSON.parse(readFileSync(path.resolve('tests', 'fixtures', `${name}.json`), 'utf8'));

const NAMES = ['ig-discovery', 'ig-reel-details', 'ig-comments', 'tiktok-videos', 'tiktok-comments'] as const;

describe('recorded fixtures (real field shapes, anonymized)', () => {
  it.each(NAMES)('%s is a non-empty array', (name) => {
    const items = load(name);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s contains no username / avatar / profile fields (privacy)', (name) => {
    const text = JSON.stringify(load(name)).toLowerCase();
    for (const forbidden of ['username', 'avatar', 'profile_pic', 'fullname', 'nickname', 'uniqueid']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('ig-discovery has the fields the Instagram normalizer will rely on', () => {
    for (const v of load('ig-discovery')) {
      expect(typeof v.shortCode).toBe('string');
      expect(typeof v.videoPlayCount).toBe('number');
      expect(typeof v.commentsCount).toBe('number');
      expect(typeof v.likesCount).toBe('number');
      expect(typeof v.timestamp).toBe('string');
    }
  });

  it('documents the Instagram quirk: hidden likes arrive as -1 and followers are absent', () => {
    const items = load('ig-discovery');
    expect(items.some((v) => v.likesCount === -1)).toBe(true);
    expect(items.every((v) => !('authorMeta' in v) && !('followersCount' in v))).toBe(true);
  });

  it('tiktok-videos has engagement counts, follower count and ad flags', () => {
    const items = load('tiktok-videos');
    for (const v of items) {
      for (const k of ['playCount', 'diggCount', 'shareCount', 'collectCount', 'commentCount']) {
        expect(typeof v[k]).toBe('number');
      }
      expect(typeof v.authorMeta.fans).toBe('number');
      expect(typeof v.isAd).toBe('boolean');
    }
    expect(items.some((v) => v.isAd === true)).toBe(true); // ads show up and must be filtered later
  });

  it('comment fixtures carry like counts and a parent video url', () => {
    for (const c of load('ig-comments')) {
      expect(typeof c.likesCount).toBe('number');
      expect(c.postUrl).toContain('instagram.com/reel/');
    }
    for (const c of load('tiktok-comments')) {
      expect(typeof c.diggCount).toBe('number');
      expect(c.videoWebUrl).toContain('tiktok.com/');
    }
  });
});
