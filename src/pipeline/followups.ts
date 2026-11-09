import { platformLabel } from '../prompts/intake';
import type { Brief, BriefField, RequiredBriefField } from '../schemas/brief';
import { REQUIRED_BRIEF_FIELDS } from '../schemas/brief';

/**
 * Deterministic follow-up logic (no LLM): which questions to ask, and what defaults to assume.
 * Rules (AGENT.md §6): ask nothing if all four fields are clear; otherwise at most 2 questions,
 * related gaps bundled; anything still unknown becomes a visible, editable assumption.
 */

export interface FollowUpQuestion {
  /** e.g. "audience+budget" */
  id: string;
  fields: RequiredBriefField[];
  text: string;
  example: string;
}

export const MAX_FOLLOW_UPS = 2;

/** Related fields are asked together, which is what keeps the count at 2 or fewer. */
const GROUPS: readonly (readonly RequiredBriefField[])[] = [
  ['audience', 'budget'], // who it's for + what they spend
  ['product', 'topic'], // what is being shown + which niche
];

const priority = (f: RequiredBriefField): number => REQUIRED_BRIEF_FIELDS.indexOf(f);
const isGap = (f: BriefField): boolean => f.status !== 'clear';
const val = (f: BriefField): string | null => (f.value && f.value.trim() ? f.value.trim() : null);

export function gapsOf(brief: Brief): RequiredBriefField[] {
  return REQUIRED_BRIEF_FIELDS.filter((f) => isGap(brief[f]));
}

export function decideFollowUps(brief: Brief): FollowUpQuestion[] {
  const gaps = gapsOf(brief);
  if (gaps.length === 0) return [];

  const groups = GROUPS.map((g) => g.filter((f) => gaps.includes(f)))
    .filter((g) => g.length > 0)
    // the group containing the highest-priority gap goes first
    .sort((a, b) => Math.min(...a.map(priority)) - Math.min(...b.map(priority)));

  return groups
    .map((fields) => buildQuestion(brief, [...fields].sort((a, b) => priority(a) - priority(b))))
    .slice(0, MAX_FOLLOW_UPS);
}

function buildQuestion(brief: Brief, fields: RequiredBriefField[]): FollowUpQuestion {
  const id = fields.join('+');
  const has = (f: RequiredBriefField) => fields.includes(f);
  const vagueQuote = (f: RequiredBriefField) =>
    brief[f].status === 'vague' && val(brief[f]) ? `"${val(brief[f])}"` : null;
  const product = brief.product.status !== 'missing' ? val(brief.product) : null;
  const topic = brief.topic.status !== 'missing' ? val(brief.topic) : null;
  const platform = platformLabel(brief.platform);

  if (has('audience') && has('budget')) {
    return {
      id,
      fields,
      text: `Who do you want this ${platform} video to reach, and roughly what's their budget${product ? ` for ${product}` : ''}?`,
      example: 'e.g. college students on a tight budget, products under $20',
    };
  }
  if (has('audience')) {
    const q = vagueQuote('audience');
    return {
      id,
      fields,
      text: q
        ? `You said ${q} for your audience - can you narrow that down (age, interests, or their main problem)?`
        : `Who is ${product ? `the ${product}` : 'this video'} for? Tell me their age, interests, or the problem they want solved.`,
      example: 'e.g. women 18-25 with oily skin who are tired of breakouts',
    };
  }
  if (has('budget')) {
    const q = vagueQuote('budget');
    return {
      id,
      fields,
      text: q
        ? `You mentioned ${q} - roughly what price point is that (low, mid-range or premium)?`
        : `What price range is ${product ?? 'your product'} in, or how much does your audience usually spend on this?`,
      example: 'e.g. under $25, mid-range, premium $100+',
    };
  }
  if (has('product') && has('topic')) {
    return {
      id,
      fields,
      text: `What are you showing or promoting in this ${platform} video, and which niche is it in (beauty, tech, fitness...)?`,
      example: 'e.g. a vitamin C serum - skincare',
    };
  }
  if (has('product')) {
    const q = vagueQuote('product');
    return {
      id,
      fields,
      text: q
        ? `You said ${q} - what exactly are you showcasing or promoting?`
        : `What exactly are you showcasing or promoting${topic ? ` in your ${topic} video` : ' in this video'}? A product, a service, or just tips with no product?`,
      example: 'e.g. a $15 vitamin C serum, or "no product - just tips"',
    };
  }
  // topic only
  const q = vagueQuote('topic');
  return {
    id,
    fields,
    text: q
      ? `You said ${q} - which niche or industry is this in (beauty, tech, fitness...)?`
      : `Which niche or industry ${product ? `does ${product} fall into` : 'is this video in'} (beauty, tech, fitness...)?`,
    example: 'e.g. skincare, budget tech, home workouts',
  };
}

// ---------- defaults / assumptions ----------

export interface Assumption {
  field: RequiredBriefField;
  value: string;
}

export interface ResolvedBrief {
  brief: Brief;
  /** The value the generator should use for each required field (user's own, or a default). */
  effective: Record<RequiredBriefField, string>;
  /** Defaults we filled in for MISSING fields; shown to the user as editable chips. */
  assumptions: Assumption[];
}

export const NO_PRODUCT_DEFAULT = 'none - personal brand / educational';

export function defaultFor(field: RequiredBriefField, brief: Brief): string {
  const topic = val(brief.topic);
  const product = val(brief.product);
  switch (field) {
    case 'audience':
      return topic ? `general short-video viewers interested in ${topic}` : 'general short-video viewers';
    case 'product':
      return NO_PRODUCT_DEFAULT;
    case 'topic':
      return product && product !== NO_PRODUCT_DEFAULT ? `general category of ${product}` : 'general lifestyle';
    case 'budget':
      return 'mid-range, accessible price point';
  }
}

/**
 * Fill every gap so generation can always proceed, and never ask a third question.
 * Missing -> default + recorded assumption. Vague -> keep the user's own words (no assumption).
 */
export function resolveBrief(brief: Brief): ResolvedBrief {
  const effective = {} as Record<RequiredBriefField, string>;
  const assumptions: Assumption[] = [];
  for (const f of REQUIRED_BRIEF_FIELDS) {
    const v = val(brief[f]);
    if (brief[f].status === 'missing' || !v) {
      const d = defaultFor(f, brief);
      effective[f] = d;
      assumptions.push({ field: f, value: d });
    } else {
      effective[f] = v;
    }
  }
  return { brief, effective, assumptions };
}
