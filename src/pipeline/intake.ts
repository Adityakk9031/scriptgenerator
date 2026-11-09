import {
  BRIEF_EXTRACTION_JSON_SCHEMA,
  BriefExtraction,
  INTAKE_MAX_OUTPUT_TOKENS,
  INTAKE_SYSTEM_PROMPT,
  buildIntakeUser,
} from '../prompts/intake';
import { Brief, REQUIRED_BRIEF_FIELDS, type BriefField } from '../schemas/brief';
import type { Platform } from '../schemas/common';
import { resolveBrief, type FollowUpQuestion, type ResolvedBrief } from './followups';
import type { StructuredLLM } from './llm';

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeError';
  }
}

export const MAX_BRIEF_CHARS = 2000;
export const MAX_ANSWER_CHARS = 500;

/** Search hashtags must have no '#', no spaces, be lowercase. The model is told, but we enforce it. */
export function cleanHashtag(tag: string): string {
  return tag.replace(/^#+/, '').replace(/\s+/g, '').toLowerCase();
}

function sanitizeExtraction(out: unknown): unknown {
  if (typeof out !== 'object' || out === null) return out;
  const o = { ...(out as Record<string, unknown>) };
  if (Array.isArray(o.hashtags)) {
    o.hashtags = [...new Set(o.hashtags.filter((t) => typeof t === 'string').map(cleanHashtag).filter(Boolean))].slice(0, 10);
  }
  if (Array.isArray(o.keywords)) o.keywords = o.keywords.filter((k) => typeof k === 'string' && k.trim()).slice(0, 10);
  return o;
}

/** Issue paths + messages only; never echo values back into a prompt. */
function describeIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** One cheap LLM call -> validated Brief. One automatic retry if the output fails validation. */
export async function extractBrief(
  llm: StructuredLLM,
  params: { platform: Platform; rawText: string; maxChars?: number },
): Promise<Brief> {
  const rawText = params.rawText.trim().slice(0, params.maxChars ?? MAX_BRIEF_CHARS);
  if (!rawText) throw new IntakeError('Please describe what your video is about.');

  let previousError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.generate({
      tier: 'analyze',
      system: INTAKE_SYSTEM_PROMPT,
      user: buildIntakeUser(params.platform, rawText, previousError),
      schemaName: 'brief_extraction',
      jsonSchema: BRIEF_EXTRACTION_JSON_SCHEMA,
      maxOutputTokens: INTAKE_MAX_OUTPUT_TOKENS,
    });
    const parsed = BriefExtraction.safeParse(sanitizeExtraction(out));
    if (parsed.success) return Brief.parse({ platform: params.platform, rawText, ...parsed.data });
    previousError = describeIssues(parsed.error);
  }
  throw new IntakeError(`Could not understand the brief (${previousError}).`);
}

// ---------- applying the user's answers ----------

const RANK = { clear: 2, vague: 1, missing: 0 } as const;

/** For each required field keep the better-specified version; on a tie prefer the newer one. */
export function mergeBriefs(prev: Brief, next: Brief): Brief {
  const pick = (a: BriefField, b: BriefField): BriefField => (RANK[b.status] >= RANK[a.status] ? b : a);
  const merged: Brief = { ...next };
  for (const f of REQUIRED_BRIEF_FIELDS) merged[f] = pick(prev[f], next[f]);
  merged.rawText = prev.rawText; // keep the user's original words
  if (next.hashtags.length === 0) merged.hashtags = prev.hashtags;
  if (next.keywords.length === 0) merged.keywords = prev.keywords;
  if (next.goal === 'unknown') merged.goal = prev.goal;
  if (next.tone === null) merged.tone = prev.tone;
  return merged;
}

/**
 * Fold the user's answers in (one more cheap LLM call, only if they actually answered),
 * then fill whatever is still unknown with defaults. Never asks a third question.
 */
export async function completeBrief(
  llm: StructuredLLM,
  brief: Brief,
  questions: FollowUpQuestion[],
  answers: Record<string, string | undefined>,
): Promise<ResolvedBrief> {
  const answered = questions
    .map((q) => ({ q, a: (answers[q.id] ?? '').trim().slice(0, MAX_ANSWER_CHARS) }))
    .filter((x) => x.a !== '');

  if (answered.length === 0) return resolveBrief(brief); // skipped -> defaults

  const combined = [brief.rawText, '', 'Follow-up answers from the creator:', ...answered.map(({ q, a }) => `Q: ${q.text}\nA: ${a}`)].join('\n');
  // room for the original brief + every answer + the question texts, so no answer gets cut off
  const maxChars = MAX_BRIEF_CHARS + questions.length * (MAX_ANSWER_CHARS + 300);
  const updated = await extractBrief(llm, { platform: brief.platform, rawText: combined, maxChars });
  return resolveBrief(mergeBriefs(brief, updated));
}
