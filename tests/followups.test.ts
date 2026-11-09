import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOW_UPS,
  NO_PRODUCT_DEFAULT,
  decideFollowUps,
  gapsOf,
  resolveBrief,
} from '../src/pipeline/followups';
import { REQUIRED_BRIEF_FIELDS, type Brief, type FieldStatus, type RequiredBriefField } from '../src/schemas/brief';

const CLEAR: Record<RequiredBriefField, string> = {
  audience: 'college girls with oily skin',
  product: 'vitamin C serum',
  topic: 'skincare',
  budget: 'under $20',
};

/** Build a brief where each listed field is in the given state; others are clear. */
function brief(states: Partial<Record<RequiredBriefField, FieldStatus>> = {}, platform: Brief['platform'] = 'instagram'): Brief {
  const field = (f: RequiredBriefField) => {
    const status = states[f] ?? 'clear';
    if (status === 'missing') return { value: null, status } as const;
    if (status === 'vague') return { value: `vague ${f}`, status } as const;
    return { value: CLEAR[f], status } as const;
  };
  return {
    platform,
    rawText: 'some request',
    topic: field('topic'),
    product: field('product'),
    audience: field('audience'),
    budget: field('budget'),
    goal: 'promote',
    tone: null,
    hashtags: ['skincare'],
    keywords: [],
  };
}

describe('decideFollowUps', () => {
  it('asks nothing when all four fields are clear', () => {
    expect(decideFollowUps(brief())).toEqual([]);
  });

  it.each<[string, Partial<Record<RequiredBriefField, FieldStatus>>, string[]]>([
    ['only budget missing', { budget: 'missing' }, ['budget']],
    ['only audience missing', { audience: 'missing' }, ['audience']],
    ['only product missing', { product: 'missing' }, ['product']],
    ['only topic missing', { topic: 'missing' }, ['topic']],
    ['audience + budget bundle into one', { audience: 'missing', budget: 'missing' }, ['audience+budget']],
    ['product + topic bundle into one', { product: 'missing', topic: 'missing' }, ['product+topic']],
    ['audience + product -> two, audience first', { audience: 'missing', product: 'missing' }, ['audience', 'product']],
    ['topic + budget -> two, topic first (higher priority)', { topic: 'missing', budget: 'missing' }, ['topic', 'budget']],
    ['product + budget -> two, product first', { product: 'missing', budget: 'missing' }, ['product', 'budget']],
    ['3 gaps (audience, product, budget) -> 2 questions', { audience: 'missing', product: 'missing', budget: 'missing' }, ['audience+budget', 'product']],
    ['3 gaps (product, topic, budget) -> product group first', { product: 'missing', topic: 'missing', budget: 'missing' }, ['product+topic', 'budget']],
    ['all 4 missing -> exactly 2 bundled questions', { audience: 'missing', product: 'missing', topic: 'missing', budget: 'missing' }, ['audience+budget', 'product+topic']],
  ])('%s', (_name, states, expectedIds) => {
    expect(decideFollowUps(brief(states)).map((q) => q.id)).toEqual(expectedIds);
  });

  it('never asks more than 2 questions, covers every gap exactly once, across all 3^4 status combos', () => {
    const statuses: FieldStatus[] = ['clear', 'vague', 'missing'];
    let combos = 0;
    for (const a of statuses)
      for (const p of statuses)
        for (const t of statuses)
          for (const b of statuses) {
            const br = brief({ audience: a, product: p, topic: t, budget: b });
            const qs = decideFollowUps(br);
            const asked = qs.flatMap((q) => q.fields);
            expect(qs.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
            expect([...asked].sort()).toEqual([...gapsOf(br)].sort()); // every gap, no duplicates
            expect(new Set(asked).size).toBe(asked.length);
            if (gapsOf(br).length === 0) expect(qs).toHaveLength(0);
            combos++;
          }
    expect(combos).toBe(81);
  });

  it('treats vague like missing for deciding to ask, and quotes what the user said', () => {
    const qs = decideFollowUps(brief({ audience: 'vague' }));
    expect(qs).toHaveLength(1);
    expect(qs[0]!.text).toContain('"vague audience"');
    const budget = decideFollowUps(brief({ budget: 'vague' }));
    expect(budget[0]!.text).toContain('"vague budget"');
  });

  it('references what the user already wrote instead of asking generic questions', () => {
    const q = decideFollowUps(brief({ audience: 'missing' }))[0]!;
    expect(q.text).toContain('vitamin C serum');
    const q2 = decideFollowUps(brief({ product: 'missing' }))[0]!;
    expect(q2.text).toContain('skincare');
    const q3 = decideFollowUps(brief({ topic: 'missing' }))[0]!;
    expect(q3.text).toContain('vitamin C serum');
  });

  it('names the platform in bundled audience questions', () => {
    expect(decideFollowUps(brief({ audience: 'missing', budget: 'missing' }, 'tiktok'))[0]!.text).toContain('TikTok');
    expect(decideFollowUps(brief({ audience: 'missing', budget: 'missing' }, 'instagram'))[0]!.text).toContain('Instagram');
  });

  it('every question has text, an example, and no leftover template artifacts', () => {
    for (const f of REQUIRED_BRIEF_FIELDS) {
      for (const status of ['missing', 'vague'] as const) {
        for (const q of decideFollowUps(brief({ [f]: status }))) {
          expect(q.text.length).toBeGreaterThan(10);
          expect(q.example.length).toBeGreaterThan(3);
          expect(q.text).not.toMatch(/undefined|null|\s{2,}|\$\{/);
        }
      }
    }
    const noTopic = brief({ product: 'missing', topic: 'missing' });
    expect(decideFollowUps({ ...noTopic, product: { value: null, status: 'missing' } })[0]!.text).not.toMatch(/\s{2,}/);
  });

  it('is deterministic', () => {
    const b = brief({ audience: 'missing', product: 'vague' });
    expect(decideFollowUps(b)).toEqual(decideFollowUps(b));
  });
});

describe('resolveBrief (defaults and assumptions)', () => {
  it('adds no assumptions when everything is clear', () => {
    const r = resolveBrief(brief());
    expect(r.assumptions).toEqual([]);
    expect(r.effective).toEqual(CLEAR);
  });

  it('fills missing fields with defaults and records each as an assumption', () => {
    const r = resolveBrief(brief({ audience: 'missing', budget: 'missing', product: 'missing' }));
    expect(r.assumptions.map((a) => a.field)).toEqual(['audience', 'product', 'budget']);
    expect(r.effective.product).toBe(NO_PRODUCT_DEFAULT);
    expect(r.effective.audience).toContain('skincare'); // default mentions the known topic
    expect(r.effective.budget).toMatch(/mid-range/);
    expect(r.effective.topic).toBe('skincare'); // untouched
  });

  it('keeps the user\'s own words for vague fields and does NOT call them assumptions', () => {
    const r = resolveBrief(brief({ audience: 'vague' }));
    expect(r.effective.audience).toBe('vague audience');
    expect(r.assumptions).toEqual([]);
  });

  it('derives a topic default from the product, or a generic one', () => {
    expect(resolveBrief(brief({ topic: 'missing' })).effective.topic).toBe('general category of vitamin C serum');
    expect(resolveBrief(brief({ topic: 'missing', product: 'missing' })).effective.topic).toBe('general lifestyle');
  });

  it('always yields a non-empty value for every required field', () => {
    const r = resolveBrief(brief({ audience: 'missing', product: 'missing', topic: 'missing', budget: 'missing' }));
    for (const f of REQUIRED_BRIEF_FIELDS) expect(r.effective[f].trim().length).toBeGreaterThan(0);
    expect(r.assumptions).toHaveLength(4);
  });
});
