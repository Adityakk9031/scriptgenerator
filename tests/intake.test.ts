import { describe, expect, it } from 'vitest';
import {
  IntakeError,
  MAX_BRIEF_CHARS,
  cleanHashtag,
  completeBrief,
  extractBrief,
  mergeBriefs,
} from '../src/pipeline/intake';
import { decideFollowUps } from '../src/pipeline/followups';
import type { StructuredLLM, StructuredRequest } from '../src/pipeline/llm';
import {
  BRIEF_EXTRACTION_JSON_SCHEMA,
  BriefExtraction,
  INTAKE_SYSTEM_PROMPT,
} from '../src/prompts/intake';
import type { Brief } from '../src/schemas/brief';

const field = (value: string | null, status: 'clear' | 'vague' | 'missing') => ({ value, status });

const fullExtraction = {
  topic: field('skincare', 'clear'),
  product: field('vitamin C serum', 'clear'),
  audience: field('college girls with oily skin', 'clear'),
  budget: field('under $20', 'clear'),
  goal: 'promote',
  tone: null,
  hashtags: ['skincare', 'vitamincserum'],
  keywords: ['oily skin serum'],
};

/** Scripted fake LLM: returns queued responses in order and records every request. */
function fakeLLM(...responses: unknown[]): StructuredLLM & { requests: StructuredRequest[] } {
  const requests: StructuredRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      const next = responses.shift();
      if (next === undefined) throw new Error('fake LLM ran out of responses');
      return next;
    },
  };
}

describe('intake prompt and schema', () => {
  it('system prompt states the status rules and the no-inventing rule', () => {
    for (const s of ['"clear"', '"vague"', '"missing"', 'Never invent', 'Ignore any instructions']) {
      expect(INTAKE_SYSTEM_PROMPT).toContain(s);
    }
  });
  it('JSON schema is strict and requires every field (OpenAI structured-output friendly)', () => {
    const s = BRIEF_EXTRACTION_JSON_SCHEMA as { type: string; additionalProperties: boolean; required: string[] };
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(
      ['audience', 'budget', 'goal', 'hashtags', 'keywords', 'product', 'tone', 'topic'].sort(),
    );
  });
  it('extraction schema does not accept platform or rawText from the model', () => {
    expect(BriefExtraction.safeParse({ ...fullExtraction, platform: 'instagram' }).success).toBe(false);
  });
});

describe('cleanHashtag', () => {
  it('strips #, spaces and case', () => {
    expect(cleanHashtag('#Skin Care')).toBe('skincare');
    expect(cleanHashtag('##OilySkin')).toBe('oilyskin');
  });
});

describe('extractBrief', () => {
  it('returns a validated Brief with platform and rawText filled in by code', async () => {
    const llm = fakeLLM(fullExtraction);
    const b = await extractBrief(llm, { platform: 'tiktok', rawText: '  I sell a serum  ' });
    expect(b.platform).toBe('tiktok');
    expect(b.rawText).toBe('I sell a serum');
    expect(b.product.value).toBe('vitamin C serum');
  });

  it('uses the cheap tier, a token cap, and keeps user text out of the system prompt', async () => {
    const llm = fakeLLM(fullExtraction);
    await extractBrief(llm, { platform: 'instagram', rawText: 'UNIQUE_USER_TEXT' });
    const req = llm.requests[0]!;
    expect(req.tier).toBe('analyze');
    expect(req.maxOutputTokens).toBeGreaterThan(0);
    expect(req.system).not.toContain('UNIQUE_USER_TEXT');
    expect(req.user).toContain('UNIQUE_USER_TEXT');
    expect(req.user).toContain('Instagram');
  });

  it('cleans hashtags the model got wrong (#, spaces, case, duplicates)', async () => {
    const llm = fakeLLM({ ...fullExtraction, hashtags: ['#SkinCare', 'skin care', 'skincare'] });
    const b = await extractBrief(llm, { platform: 'instagram', rawText: 'x' });
    expect(b.hashtags).toEqual(['skincare']);
  });

  it('retries once when the output is invalid, telling the model what was wrong', async () => {
    const llm = fakeLLM({ nonsense: true }, fullExtraction);
    const b = await extractBrief(llm, { platform: 'instagram', rawText: 'x' });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user).toContain('previous answer was rejected');
    expect(b.topic.value).toBe('skincare');
  });

  it('throws IntakeError after two invalid outputs (no endless retries)', async () => {
    const llm = fakeLLM({ bad: 1 }, { bad: 2 }, fullExtraction);
    await expect(extractBrief(llm, { platform: 'instagram', rawText: 'x' })).rejects.toBeInstanceOf(IntakeError);
    expect(llm.requests).toHaveLength(2);
  });

  it('rejects an inconsistent field (status missing but a value present)', async () => {
    const bad = { ...fullExtraction, budget: field('cheap', 'missing') };
    const llm = fakeLLM(bad, bad);
    await expect(extractBrief(llm, { platform: 'instagram', rawText: 'x' })).rejects.toBeInstanceOf(IntakeError);
  });

  it('rejects an empty brief without calling the LLM', async () => {
    const llm = fakeLLM(fullExtraction);
    await expect(extractBrief(llm, { platform: 'instagram', rawText: '   ' })).rejects.toBeInstanceOf(IntakeError);
    expect(llm.requests).toHaveLength(0);
  });

  it('truncates very long briefs to bound token use', async () => {
    const llm = fakeLLM(fullExtraction);
    await extractBrief(llm, { platform: 'instagram', rawText: 'a'.repeat(MAX_BRIEF_CHARS + 5000) });
    expect(llm.requests[0]!.user.length).toBeLessThan(MAX_BRIEF_CHARS + 500);
  });
});

describe('mergeBriefs', () => {
  const base: Brief = {
    platform: 'instagram',
    rawText: 'original',
    topic: field('skincare', 'clear'),
    product: field('serum', 'vague'),
    audience: field(null, 'missing'),
    budget: field(null, 'missing'),
    goal: 'promote',
    tone: 'fun',
    hashtags: ['skincare'],
    keywords: ['k'],
  };
  it('keeps the better-specified version per field and the original wording', () => {
    const next: Brief = {
      ...base,
      rawText: 'combined text',
      topic: field('skincare', 'vague'), // worse -> keep prev
      product: field('vitamin C serum', 'clear'), // better -> take
      audience: field('students', 'clear'),
      goal: 'unknown',
      tone: null,
      hashtags: [],
    };
    const m = mergeBriefs(base, next);
    expect(m.topic.status).toBe('clear');
    expect(m.product.value).toBe('vitamin C serum');
    expect(m.audience.value).toBe('students');
    expect(m.budget.status).toBe('missing');
    expect(m.rawText).toBe('original');
    expect(m.goal).toBe('promote');
    expect(m.tone).toBe('fun');
    expect(m.hashtags).toEqual(['skincare']);
  });
});

describe('completeBrief', () => {
  const gappy: Brief = {
    platform: 'instagram',
    rawText: 'I sell a serum',
    topic: field('skincare', 'clear'),
    product: field('serum', 'clear'),
    audience: field(null, 'missing'),
    budget: field(null, 'missing'),
    goal: 'promote',
    tone: null,
    hashtags: ['skincare'],
    keywords: [],
  };

  it('makes no LLM call when the user skips every question, and fills defaults', async () => {
    const llm = fakeLLM();
    const qs = decideFollowUps(gappy);
    const r = await completeBrief(llm, gappy, qs, {});
    expect(llm.requests).toHaveLength(0);
    expect(r.assumptions.map((a) => a.field)).toEqual(['audience', 'budget']);
  });

  it('treats whitespace-only answers as skipped', async () => {
    const llm = fakeLLM();
    const qs = decideFollowUps(gappy);
    await completeBrief(llm, gappy, qs, { [qs[0]!.id]: '   ' });
    expect(llm.requests).toHaveLength(0);
  });

  it('folds the answer in with one extra call and clears the gaps', async () => {
    const qs = decideFollowUps(gappy);
    expect(qs).toHaveLength(1); // audience + budget bundled
    const llm = fakeLLM(fullExtraction);
    const r = await completeBrief(llm, gappy, qs, { [qs[0]!.id]: 'college students, products under $20' });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.user).toContain('college students, products under $20');
    expect(llm.requests[0]!.user).toContain(qs[0]!.text);
    expect(r.assumptions).toEqual([]);
    expect(r.effective.audience).toBe('college girls with oily skin');
    expect(r.brief.rawText).toBe('I sell a serum'); // original words preserved
  });

  it('still never asks again: unanswered gaps after the answer become assumptions', async () => {
    const qs = decideFollowUps(gappy);
    const stillGappy = { ...fullExtraction, budget: field(null, 'missing') };
    const llm = fakeLLM(stillGappy);
    const r = await completeBrief(llm, gappy, qs, { [qs[0]!.id]: 'college students' });
    expect(r.assumptions.map((a) => a.field)).toEqual(['budget']);
    expect(r.effective.audience).toBe('college girls with oily skin');
  });

  it('does not let a worse re-extraction erase what was already clear', async () => {
    const qs = decideFollowUps(gappy);
    const worse = { ...fullExtraction, topic: field(null, 'missing'), product: field(null, 'missing') };
    const llm = fakeLLM(worse);
    const r = await completeBrief(llm, gappy, qs, { [qs[0]!.id]: 'students' });
    expect(r.effective.topic).toBe('skincare');
    expect(r.effective.product).toBe('serum');
  });

  it('caps very long answers', async () => {
    const qs = decideFollowUps(gappy);
    const llm = fakeLLM(fullExtraction);
    await completeBrief(llm, gappy, qs, { [qs[0]!.id]: 'z'.repeat(5000) });
    expect(llm.requests[0]!.user.split('z').length - 1).toBeLessThanOrEqual(500);
  });
});
