import { describe, expect, it } from 'vitest';
import { Brief } from '../src/schemas/brief';
import { Comment } from '../src/schemas/comment';
import { Script, ScriptSet } from '../src/schemas/script';
import { Video } from '../src/schemas/video';

const field = (value: string | null, status: 'clear' | 'vague' | 'missing') => ({ value, status });

const validBrief = {
  platform: 'instagram',
  rawText: 'I sell an affordable vitamin C serum for oily skin, target is college girls',
  topic: field('skincare', 'clear'),
  product: field('vitamin C serum', 'clear'),
  audience: field('college girls with oily skin', 'clear'),
  budget: field(null, 'missing'),
  goal: 'promote',
  tone: null,
  hashtags: ['skincare', 'vitamincserum'],
  keywords: ['oily skin serum'],
} as const;

const validVideo = {
  id: 'abc123',
  platform: 'tiktok',
  url: 'https://www.tiktok.com/@someone/video/123',
  caption: 'my 3 step routine',
  hashtags: ['skincare'],
  views: 120000,
  likes: 9000,
  comments: 400,
  shares: null,
  saves: 700,
  authorFollowers: 15000,
  isPaid: false,
  publishedAt: '2026-10-30T10:00:00.000Z',
  durationSec: 31,
  transcript: null,
};

const validComment = {
  id: 'c1',
  videoId: 'abc123',
  platform: 'tiktok',
  text: 'where do I buy this?',
  likes: 52,
  replyCount: 3,
  createdAt: null,
};

const validScript = {
  label: 'Bold / Contrarian',
  hook_type: 'contrarian_claim',
  segments: {
    hook: 'Stop layering five serums.',
    hold: 'Your skin barrier is crying and one cheap step fixes it. I will show you which.',
    body: ['Beat one.', 'Beat two.'],
    close: 'Save this for tonight.',
  },
  on_screen_text: ['1 step, not 5'],
  word_count_total: 148,
  word_count_window: 36,
  est_seconds: 58,
  why_it_works: 'Top videos open with a contrarian claim.',
  expected_response: { profile: 'Drives comments and saves.', benchmark: 'Niche median ~40k views (estimate).' },
  best_for: 'Skeptical audiences',
  risk: 'Can feel preachy',
};

describe('Brief', () => {
  it('accepts a valid brief with a missing field', () => {
    expect(Brief.safeParse(validBrief).success).toBe(true);
  });
  it('rejects a missing field that still has a value', () => {
    expect(Brief.safeParse({ ...validBrief, budget: field('cheap', 'missing') }).success).toBe(false);
  });
  it('rejects a clear field with no value', () => {
    expect(Brief.safeParse({ ...validBrief, topic: field(null, 'clear') }).success).toBe(false);
    expect(Brief.safeParse({ ...validBrief, topic: field('  ', 'vague') }).success).toBe(false);
  });
  it('rejects hashtags that contain # or spaces', () => {
    expect(Brief.safeParse({ ...validBrief, hashtags: ['#skincare'] }).success).toBe(false);
    expect(Brief.safeParse({ ...validBrief, hashtags: ['skin care'] }).success).toBe(false);
  });
  it('rejects unsupported platforms (linkedin, x)', () => {
    expect(Brief.safeParse({ ...validBrief, platform: 'linkedin' }).success).toBe(false);
    expect(Brief.safeParse({ ...validBrief, platform: 'x' }).success).toBe(false);
  });
  it('rejects empty rawText', () => {
    expect(Brief.safeParse({ ...validBrief, rawText: '' }).success).toBe(false);
  });
});

describe('Video', () => {
  it('accepts a valid video', () => {
    expect(Video.safeParse(validVideo).success).toBe(true);
  });
  it('allows hidden likes (null) but not the raw -1 sentinel', () => {
    expect(Video.safeParse({ ...validVideo, likes: null }).success).toBe(true);
    expect(Video.safeParse({ ...validVideo, likes: -1 }).success).toBe(false);
  });
  it('requires the isPaid flag', () => {
    const { isPaid: _omit, ...rest } = validVideo;
    expect(Video.safeParse(rest).success).toBe(false);
  });
  it('rejects negative or fractional counts', () => {
    expect(Video.safeParse({ ...validVideo, views: -1 }).success).toBe(false);
    expect(Video.safeParse({ ...validVideo, likes: 1.5 }).success).toBe(false);
  });
  it('rejects a bad url and a bad date', () => {
    expect(Video.safeParse({ ...validVideo, url: 'not a url' }).success).toBe(false);
    expect(Video.safeParse({ ...validVideo, publishedAt: 'yesterday' }).success).toBe(false);
  });
  it('rejects unknown keys such as an author handle', () => {
    expect(Video.safeParse({ ...validVideo, authorHandle: 'someone' }).success).toBe(false);
  });
});

describe('Comment', () => {
  it('accepts a valid comment', () => {
    expect(Comment.safeParse(validComment).success).toBe(true);
  });
  it('rejects usernames/handles (privacy)', () => {
    expect(Comment.safeParse({ ...validComment, username: 'jane' }).success).toBe(false);
    expect(Comment.safeParse({ ...validComment, authorHandle: '@jane' }).success).toBe(false);
  });
  it('rejects empty text and negative likes', () => {
    expect(Comment.safeParse({ ...validComment, text: '' }).success).toBe(false);
    expect(Comment.safeParse({ ...validComment, likes: -2 }).success).toBe(false);
  });
});

describe('Script / ScriptSet', () => {
  it('accepts a valid script', () => {
    expect(Script.safeParse(validScript).success).toBe(true);
  });
  it('rejects an unknown hook type', () => {
    expect(Script.safeParse({ ...validScript, hook_type: 'clickbait' }).success).toBe(false);
  });
  it('requires 2-3 body beats', () => {
    const seg = validScript.segments;
    expect(Script.safeParse({ ...validScript, segments: { ...seg, body: ['one'] } }).success).toBe(false);
    expect(Script.safeParse({ ...validScript, segments: { ...seg, body: ['a', 'b', 'c', 'd'] } }).success).toBe(false);
  });
  it('requires an honest expected_response with profile and benchmark', () => {
    const bad = { ...validScript, expected_response: { profile: 'x' } };
    expect(Script.safeParse(bad).success).toBe(false);
  });
  it('accepts 2 or 3 scripts, rejects 1 or 4', () => {
    const set = (n: number) => ({ assumptions: [], scripts: Array.from({ length: n }, () => validScript) });
    expect(ScriptSet.safeParse(set(1)).success).toBe(false);
    expect(ScriptSet.safeParse(set(2)).success).toBe(true);
    expect(ScriptSet.safeParse(set(3)).success).toBe(true);
    expect(ScriptSet.safeParse(set(4)).success).toBe(false);
  });
  it('accepts assumptions only for known brief fields', () => {
    const ok = { assumptions: [{ field: 'budget', value: 'mid-range' }], scripts: [validScript, validScript] };
    const bad = { assumptions: [{ field: 'color', value: 'red' }], scripts: [validScript, validScript] };
    expect(ScriptSet.safeParse(ok).success).toBe(true);
    expect(ScriptSet.safeParse(bad).success).toBe(false);
  });
});
