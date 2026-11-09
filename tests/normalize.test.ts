import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  igShortCodeFromUrl,
  normalizeComments,
  normalizeIgComment,
  normalizeIgReel,
  normalizeIgTranscript,
  normalizeTikTokComment,
  normalizeTikTokVideo,
  normalizeVideos,
  redactMentions,
  tiktokIdFromUrl,
} from '../src/apify/normalize';
import { Comment } from '../src/schemas/comment';
import { Video } from '../src/schemas/video';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = (name: string): Item[] => JSON.parse(readFileSync(path.resolve('tests', 'fixtures', `${name}.json`), 'utf8'));

describe('url helpers', () => {
  it('extracts instagram shortcodes', () => {
    expect(igShortCodeFromUrl('https://www.instagram.com/reel/AbC_123-x/')).toBe('AbC_123-x');
    expect(igShortCodeFromUrl('https://www.instagram.com/someone/reel/AbC123/')).toBe('AbC123');
    expect(igShortCodeFromUrl('https://example.com/nope')).toBeNull();
    expect(igShortCodeFromUrl(null)).toBeNull();
  });
  it('extracts tiktok video ids', () => {
    expect(tiktokIdFromUrl('https://www.tiktok.com/@u/video/7696968386424638733')).toBe('7696968386424638733');
    expect(tiktokIdFromUrl('https://www.tiktok.com/@u')).toBeNull();
  });
});

describe('Instagram video normalizer (real fixture)', () => {
  const { items, dropped } = normalizeVideos('instagram', fx('ig-discovery'));

  it('normalizes all 5 recorded reels into valid Videos', () => {
    expect(items).toHaveLength(5);
    expect(dropped).toBe(0);
    for (const v of items) expect(Video.safeParse(v).success).toBe(true);
  });
  it('maps hidden likes (-1) to null, never to 0 or -1', () => {
    const likes = items.map((v) => v.likes);
    expect(likes.filter((l) => l === null)).toHaveLength(2);
    expect(likes.every((l) => l === null || l >= 0)).toBe(true);
  });
  it('uses play count as views and keeps shares only when provided', () => {
    expect(items[0]!.views).toBe(45015);
    expect(items[0]!.shares).toBe(9);
    expect(items[4]!.shares).toBeNull();
  });
  it('has no follower count for Instagram and is not paid', () => {
    expect(items.every((v) => v.authorFollowers === null && v.isPaid === false)).toBe(true);
  });
  it('lowercases hashtags without the # sign', () => {
    expect(items[0]!.hashtags).toContain('skincare');
    expect(items.flatMap((v) => v.hashtags).some((h) => h.startsWith('#'))).toBe(false);
  });
});

describe('Instagram edge cases', () => {
  const base = { shortCode: 'abc', type: 'Video', videoPlayCount: 10, commentsCount: 1, likesCount: 5 };
  it('drops items without views, without shortCode, or that are not videos', () => {
    expect(normalizeIgReel({ ...base, videoPlayCount: undefined })).toBeNull();
    expect(normalizeIgReel({ ...base, shortCode: undefined })).toBeNull();
    expect(normalizeIgReel({ ...base, type: 'Sidecar' })).toBeNull();
    expect(normalizeIgReel(null)).toBeNull();
    expect(normalizeIgReel('nope')).toBeNull();
  });
  it('falls back from videoPlayCount to igPlayCount to videoViewCount', () => {
    expect(normalizeIgReel({ ...base, videoPlayCount: undefined, igPlayCount: 77 })!.views).toBe(77);
    expect(normalizeIgReel({ ...base, videoPlayCount: undefined, videoViewCount: 55 })!.views).toBe(55);
  });
  it('flags paid partnerships', () => {
    expect(normalizeIgReel({ ...base, paidPartnership: true })!.isPaid).toBe(true);
  });
  it('builds a reel url when the actor omits it', () => {
    expect(normalizeIgReel(base)!.url).toBe('https://www.instagram.com/reel/abc/');
  });
  it('extracts transcripts from reel-details output', () => {
    const t = normalizeIgTranscript(fx('ig-reel-details')[0]);
    expect(t?.videoId).toBeTruthy();
    expect(t?.transcript.length).toBeGreaterThan(10);
    expect(normalizeIgTranscript({ shortCode: 'x', transcript: '' })).toBeNull();
  });
});

describe('TikTok video normalizer (real fixture)', () => {
  const { items, dropped } = normalizeVideos('tiktok', fx('tiktok-videos'));

  it('normalizes all 5 recorded videos into valid Videos', () => {
    expect(items).toHaveLength(5);
    expect(dropped).toBe(0);
    for (const v of items) expect(Video.safeParse(v).success).toBe(true);
  });
  it('maps counts, saves and follower count', () => {
    expect(items[0]!.views).toBe(4700000);
    expect(items[0]!.likes).toBe(269800);
    expect(items[0]!.shares).toBe(4648);
    expect(items[0]!.saves).toBe(55932);
    expect(items[0]!.authorFollowers).toBe(4500000);
  });
  it('flags ads / sponsored videos as paid', () => {
    expect(items[0]!.isPaid).toBe(true); // isAd + isSponsored
    expect(items[1]!.isPaid).toBe(false);
    expect(items[4]!.isPaid).toBe(true); // isAd only
  });
  it('reads duration and hashtag names', () => {
    expect(items[0]!.durationSec).toBe(66);
    expect(items[0]!.hashtags.length).toBeGreaterThan(0);
  });
});

describe('TikTok edge cases', () => {
  const base = { id: '1', webVideoUrl: 'https://www.tiktok.com/@u/video/1', playCount: 10 };
  it('drops slideshows and items missing id, url or views', () => {
    expect(normalizeTikTokVideo({ ...base, isSlideshow: true })).toBeNull();
    expect(normalizeTikTokVideo({ ...base, id: undefined })).toBeNull();
    expect(normalizeTikTokVideo({ ...base, webVideoUrl: undefined })).toBeNull();
    expect(normalizeTikTokVideo({ ...base, playCount: undefined })).toBeNull();
  });
  it('uses null (not 0) for missing signals', () => {
    const v = normalizeTikTokVideo(base)!;
    expect(v.likes).toBeNull();
    expect(v.shares).toBeNull();
    expect(v.saves).toBeNull();
    expect(v.authorFollowers).toBeNull();
    expect(v.durationSec).toBeNull();
  });
  it('dedupes repeated videos', () => {
    const { items, dropped } = normalizeVideos('tiktok', [base, base]);
    expect(items).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe('comment normalizers', () => {
  it('normalizes the Instagram comment fixture and links it to the reel', () => {
    const { items } = normalizeComments('instagram', fx('ig-comments'));
    expect(items).toHaveLength(10);
    const reel = normalizeVideos('instagram', fx('ig-discovery')).items[0]!;
    expect(items.every((c) => c.videoId === reel.id)).toBe(true);
    for (const c of items) expect(Comment.safeParse(c).success).toBe(true);
  });
  it('normalizes the TikTok comment fixture with real like counts', () => {
    const { items } = normalizeComments('tiktok', fx('tiktok-comments'));
    expect(items).toHaveLength(10);
    expect(Math.max(...items.map((c) => c.likes))).toBe(12662);
    const video = normalizeVideos('tiktok', fx('tiktok-videos')).items[0]!;
    expect(items.every((c) => c.videoId === video.id)).toBe(true);
  });
  it('outputs ONLY allowed keys, so no username/handle can leak', () => {
    const allowed = ['id', 'videoId', 'platform', 'text', 'likes', 'replyCount', 'createdAt'].sort();
    for (const platform of ['instagram', 'tiktok'] as const) {
      const raw = fx(platform === 'instagram' ? 'ig-comments' : 'tiktok-comments');
      // simulate the real actor output, which carries usernames
      const withPii = raw.map((r) => ({ ...r, ownerUsername: 'jane', uniqueId: 'jane', avatarThumbnail: 'http://x' }));
      for (const c of normalizeComments(platform, withPii).items) {
        expect(Object.keys(c).sort()).toEqual(allowed);
      }
    }
  });
  it('redacts @mentions inside comment text', () => {
    expect(redactMentions('thanks @jane.doe_1 and @bob!')).toBe('thanks @user and @user!');
    const c = normalizeIgComment({ id: '1', postUrl: 'https://www.instagram.com/reel/abc/', text: 'ask @someone' });
    expect(c!.text).toBe('ask @user');
  });
  it('drops empty text, missing ids and replies', () => {
    const url = 'https://www.tiktok.com/@u/video/9';
    expect(normalizeTikTokComment({ cid: '1', videoWebUrl: url, text: '   ' })).toBeNull();
    expect(normalizeTikTokComment({ videoWebUrl: url, text: 'hi' })).toBeNull();
    expect(normalizeTikTokComment({ cid: '1', videoWebUrl: url, text: 'hi', repliesToId: '55' })).toBeNull();
    expect(normalizeTikTokComment({ cid: '1', videoWebUrl: 'https://www.tiktok.com/@u', text: 'hi' })).toBeNull();
    expect(normalizeIgComment({ id: '1', postUrl: 'https://nope.com', text: 'hi' })).toBeNull();
  });
  it('keeps emoji-only comments (the miner filters noise later) and dedupes by id', () => {
    const url = 'https://www.tiktok.com/@u/video/9';
    const raw = { cid: '1', videoWebUrl: url, text: '😍😍😍', diggCount: 3 };
    const { items, dropped } = normalizeComments('tiktok', [raw, raw]);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('😍😍😍');
    expect(dropped).toBe(1);
  });
});
