import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeComments } from '../src/apify/normalize';
import { classifyComment, cleanCommentText, mineComments } from '../src/pipeline/comments';
import type { Comment } from '../src/schemas/comment';

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fx = (name: string): Item[] => JSON.parse(readFileSync(path.resolve('tests', 'fixtures', `${name}.json`), 'utf8'));

let n = 0;
const c = (text: string, likes = 0): Comment => ({
  id: `c${++n}`,
  videoId: 'v1',
  platform: 'tiktok',
  text,
  likes,
  replyCount: null,
  createdAt: null,
});

describe('cleanCommentText (noise / safety filter)', () => {
  it.each([
    ['😍😍😍', 'emoji only'],
    ['!!!', 'punctuation only'],
    ['12345', 'digits only'],
    ['first!', 'noise word'],
    ['LOL', 'noise word, any case'],
    ['ok', 'too short / noise'],
    ['aaaaaaaaaa so good', 'repeated-character spam'],
    ['follow me for follow back', 'spam'],
    ['dm me for promo', 'spam'],
    ['email me at jane@example.com', 'contains an email'],
    ['call 555 123 4567 now', 'contains a phone number'],
    ['   ', 'blank'],
  ])('drops %j (%s)', (text) => {
    expect(cleanCommentText(text)).toBeNull();
  });

  it('keeps real comments and tidies them (urls, @user tokens, whitespace)', () => {
    expect(cleanCommentText('  where   can I buy this?  ')).toBe('where can I buy this?');
    expect(cleanCommentText('@user does it work? https://spam.example/x')).toBe('does it work?');
    expect(cleanCommentText('Love this 😍 so much')).toBe('Love this 😍 so much');
  });
});

describe('classifyComment', () => {
  it.each<[string, ReturnType<typeof classifyComment>]>([
    // intent: buying / saving / sharing signals
    ['where can I buy this?', 'intent'],
    ['link please', 'intent'],
    ['how much is it', 'intent'],
    ['omg I need this', 'intent'],
    ['sent this to my sister', 'intent'],
    ['saving this for later', 'intent'],
    ['what is the name of the product', 'intent'],
    ['part 2 please', 'intent'],
    ['take my money', 'intent'],
    // objections: doubts to pre-empt
    ['looks fake tbh', 'objection'],
    ['this is just an ad', 'objection'],
    ['it did not work for me', 'objection'],
    ['I got allergic to something similar', 'objection'],
    ['too good to be true honestly', 'objection'],
    ['is this a scam?', 'objection'], // objection wins over question
    // questions: unmet demand
    ['does this work on oily skin?', 'question'],
    ['how long until you see results', 'question'],
    ['can you use it with retinol?', 'question'],
    ['is it safe for sensitive skin', 'question'],
    // quotable: audience vocabulary
    ['this is the best tip I have seen all year', 'quotable'],
    ['my skin has never looked this good honestly', 'quotable'],
    // nothing
    ['so pretty', null],
    ['yes queen', null],
  ])('%j -> %s', (text, bucket) => {
    expect(classifyComment(text)).toBe(bucket);
  });

  it('does not treat a statement starting with a question word but too short as a question', () => {
    expect(classifyComment('what')).toBeNull();
  });
});

describe('mineComments', () => {
  it('buckets, ranks by likes, and reports stats', () => {
    const r = mineComments([
      c('does this work on oily skin?', 40),
      c('how long until you see results', 90),
      c('looks fake tbh', 25),
      c('link please', 300),
      c('sent this to my sister', 120),
      c('this is the best tip I have seen all year', 60),
      c('😍😍😍', 999),
    ]);
    expect(r.questions.map((m) => m.text)).toEqual(['how long until you see results', 'does this work on oily skin?']);
    expect(r.objections.map((m) => m.text)).toEqual(['looks fake tbh']);
    expect(r.intent.map((m) => m.text)).toEqual(['link please', 'sent this to my sister']);
    expect(r.quotable.map((m) => m.text)).toEqual(['this is the best tip I have seen all year']);
    expect(r.stats.input).toBe(7);
    expect(r.stats.kept).toBe(6);
    expect(r.stats.dropped).toBe(1);
    expect(r.stats.byBucket).toEqual({ intent: 2, objection: 1, question: 2, quotable: 1 });
  });

  it('merges near-duplicates, keeps the most-liked wording and counts them', () => {
    const r = mineComments([c('Where can I buy this?', 3), c('where can i buy this', 50), c('WHERE CAN I BUY THIS!!', 1)]);
    expect(r.intent).toHaveLength(1);
    expect(r.intent[0]).toMatchObject({ text: 'where can i buy this', likes: 50, count: 3 });
  });

  it('trims each bucket to its max and shortens long comments', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`does version ${i} work on oily skin?`, i));
    const r = mineComments(many, { maxQuestions: 3 });
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]!.likes).toBe(19);
    expect(r.stats.byBucket.question).toBe(20); // stats count everything, output is trimmed

    const long = mineComments([c(`does this work ${'really '.repeat(60)}well?`, 1)], { maxChars: 50 });
    expect(long.questions[0]!.text.length).toBeLessThanOrEqual(50);
    expect(long.questions[0]!.text.endsWith('…')).toBe(true);
  });

  it('is deterministic when likes tie', () => {
    const list = [c('does b work on oily skin?', 5), c('does a work on oily skin?', 5)];
    const a = mineComments(list).questions.map((m) => m.text);
    const b = mineComments([...list].reverse()).questions.map((m) => m.text);
    expect(a).toEqual(b);
  });

  it('handles empty input', () => {
    const r = mineComments([]);
    expect(r.intent).toEqual([]);
    expect(r.stats).toMatchObject({ input: 0, kept: 0, dropped: 0 });
  });

  it('never outputs emails, phone numbers, links or @handles', () => {
    const r = mineComments([
      c('ask @someone about it, does this work?', 5),
      c('mail me jane@example.com does this work?', 9),
      c('call 5551234567 where can I buy this', 9),
      c('see https://spam.example/x where can I buy this', 7),
    ]);
    const all = JSON.stringify(r);
    expect(all).not.toMatch(/jane@example|5551234567|https?:\/\//);
    expect(all).not.toMatch(/@\w/);
  });

  it('works end-to-end on the recorded TikTok + Instagram comment fixtures', () => {
    for (const [name, platform] of [['tiktok-comments', 'tiktok'], ['ig-comments', 'instagram']] as const) {
      const comments = normalizeComments(platform, fx(name)).items;
      const r = mineComments(comments);
      expect(r.stats.input).toBe(10);
      expect(r.intent.length).toBeGreaterThan(0); // "where can I buy this?", "link please", "how much"...
      expect(r.objections.map((m) => m.text)).toContain('looks fake tbh');
      expect(r.questions.map((m) => m.text)).toContain('does this work on oily skin?');
      // emoji-only and "first!" are noise
      const texts = [...r.intent, ...r.objections, ...r.questions, ...r.quotable].map((m) => m.text);
      expect(texts).not.toContain('😍😍😍');
      expect(texts).not.toContain('first!');
    }
  });
});
