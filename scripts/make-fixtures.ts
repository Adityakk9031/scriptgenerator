/**
 * Turns the raw samples in data/raw-samples/ (gitignored) into small, anonymized test fixtures in tests/fixtures/.
 * Keeps only the fields normalizers need. Drops usernames, names, avatars, media URLs.
 * Comment texts are replaced with synthetic ones (real people's comments never enter the repo).
 *
 *   npx tsx scripts/make-fixtures.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RAW = path.resolve('data', 'raw-samples');
const OUT = path.resolve('tests', 'fixtures');

const read = async (name: string): Promise<Item[]> => JSON.parse(await readFile(path.join(RAW, `${name}.json`), 'utf8'));
const write = (name: string, data: unknown) => writeFile(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2) + '\n', 'utf8');

// Synthetic comments (incl. emoji-only / question / objection edge cases) used instead of real text.
const FAKE_COMMENTS = [
  'where can I buy this?',
  '😍😍😍',
  'does this work on oily skin?',
  'looks fake tbh',
  'omg I need this',
  'first!',
  'sent this to my sister',
  'how much is it',
  'this is the best tip I have seen',
  'link please',
];
const fakeText = (i: number) => FAKE_COMMENTS[i % FAKE_COMMENTS.length]!;
const trunc = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : s);

await mkdir(OUT, { recursive: true });

const igDiscovery = (await read('ig-discovery')).map((v) => ({
  type: v.type,
  shortCode: v.shortCode,
  url: `https://www.instagram.com/reel/${v.shortCode}/`,
  caption: trunc(v.caption, 300),
  hashtags: v.hashtags,
  commentsCount: v.commentsCount,
  likesCount: v.likesCount, // -1 = hidden
  videoPlayCount: v.videoPlayCount,
  igPlayCount: v.igPlayCount,
  sharesCount: v.sharesCount ?? null,
  timestamp: v.timestamp,
  videoDuration: v.videoDuration,
  productType: v.productType,
  paidPartnership: v.paidPartnership,
}));

const igDetails = (await read('ig-reel-details')).map((v) => ({
  shortCode: v.shortCode,
  url: `https://www.instagram.com/reel/${v.shortCode}/`,
  caption: trunc(v.caption, 300),
  hashtags: v.hashtags,
  commentsCount: v.commentsCount,
  likesCount: v.likesCount,
  videoPlayCount: v.videoPlayCount,
  videoViewCount: v.videoViewCount,
  timestamp: v.timestamp,
  videoDuration: v.videoDuration,
  transcript: trunc(v.transcript, 400),
}));

const tiktokVideos = (await read('tiktok-videos')).map((v, i) => ({
  id: v.id,
  text: trunc(v.text, 300),
  createTimeISO: v.createTimeISO,
  isAd: v.isAd,
  isSponsored: v.isSponsored,
  authorMeta: { fans: v.authorMeta?.fans ?? null },
  webVideoUrl: `https://www.tiktok.com/@user${i + 1}/video/${v.id}`,
  videoMeta: { duration: v.videoMeta?.duration ?? null, subtitleLinks: (v.videoMeta?.subtitleLinks ?? []).length > 0 ? [{ language: 'eng-US', downloadLink: 'https://example.invalid/sub.vtt' }] : [] },
  diggCount: v.diggCount,
  shareCount: v.shareCount,
  playCount: v.playCount,
  collectCount: v.collectCount,
  commentCount: v.commentCount,
  hashtags: (v.hashtags ?? []).map((h: Item) => ({ name: h.name })),
  isSlideshow: v.isSlideshow,
}));

const firstReel = igDiscovery[0]!;
const igComments = (await read('ig-comments')).map((c, i) => ({
  id: String(c.id),
  postUrl: firstReel.url,
  text: fakeText(i),
  timestamp: c.timestamp,
  repliesCount: c.repliesCount,
  likesCount: c.likesCount,
}));

const firstTikTok = tiktokVideos[0]!;
const tiktokComments = (await read('tiktok-comments')).map((c, i) => ({
  cid: c.cid,
  videoWebUrl: firstTikTok.webVideoUrl,
  text: fakeText(i + 3),
  diggCount: c.diggCount,
  createTimeISO: c.createTimeISO,
  replyCommentTotal: c.replyCommentTotal,
  repliesToId: c.repliesToId,
}));

await write('ig-discovery', igDiscovery);
await write('ig-reel-details', igDetails);
await write('tiktok-videos', tiktokVideos);
await write('ig-comments', igComments);
await write('tiktok-comments', tiktokComments);
console.log('Fixtures written to tests/fixtures/');
