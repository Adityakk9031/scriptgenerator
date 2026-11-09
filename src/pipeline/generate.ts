import { LlmError } from '../openai/client';
import type { Analysis } from '../prompts/analyze';
import { GENERATE_MAX_OUTPUT_TOKENS, GENERATE_SYSTEM_PROMPT, SCRIPT_SET_JSON_SCHEMA, buildGenerateUser } from '../prompts/generate';
import type { Comment } from '../schemas/comment';
import type { ScriptSet } from '../schemas/script';
import type { Video } from '../schemas/video';
import type { ResolvedBrief } from './followups';
import type { StructuredLLM } from './llm';
import type { Benchmarks } from './stats';
import { validateScriptSet, type ScriptIssue, type ValidationResult } from './validate';

export class ScriptGenerationError extends Error {
  readonly issues: ScriptIssue[];
  constructor(message: string, issues: ScriptIssue[]) {
    super(message);
    this.name = 'ScriptGenerationError';
    this.issues = issues;
  }
}

export interface GenerateResult {
  set: ScriptSet;
  issues: ScriptIssue[];
  attempts: number;
  /** true when some scripts failed the checks twice and were dropped. */
  degraded: boolean;
}

const MAX_ATTEMPTS = 2;

/** Everything the scripts must not copy from. */
export function collectSources(params: { videos: Video[]; comments: Comment[]; analysis: Analysis }): string[] {
  return [
    ...params.videos.flatMap((v) => [v.caption, v.transcript ?? '']),
    ...params.comments.map((c) => c.text),
    ...params.analysis.hook_patterns.map((h) => h.example_opening),
    ...params.analysis.audience_vocabulary,
  ].filter(Boolean);
}

export function buildRepairUser(base: string, previous: unknown, issues: ScriptIssue[]): string {
  const problems = issues.filter((i) => i.severity === 'error').map((i) => `- ${i.message}`).join('\n');
  return `${base}\n\nYour previous answer was rejected. Fix exactly these problems and keep everything else:\n${problems}\n\nPrevious answer:\n${JSON.stringify(previous)}`;
}

/** One call, code validation, one automatic repair retry. Scripts that still fail are dropped if at least 2 survive. */
export async function generateScripts(
  llm: StructuredLLM,
  params: { resolved: ResolvedBrief; analysis: Analysis; benchmarks: Benchmarks; sources: string[] },
): Promise<GenerateResult> {
  const base = buildGenerateUser(params);
  const ctx = { assumptions: params.resolved.assumptions, benchmarks: params.benchmarks, sources: params.sources };
  let user = base;
  let last: ValidationResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: unknown;
    try {
      raw = await llm.generate({
        tier: 'generate',
        system: GENERATE_SYSTEM_PROMPT,
        user,
        schemaName: 'script_set',
        jsonSchema: SCRIPT_SET_JSON_SCHEMA,
        maxOutputTokens: GENERATE_MAX_OUTPUT_TOKENS,
      });
    } catch (e) {
      if (e instanceof LlmError && ['truncated', 'invalid_json', 'empty'].includes(e.kind)) {
        if (attempt < MAX_ATTEMPTS) continue;
        if (last) break; // a failed repair must not throw away what the earlier attempt produced
      }
      throw e;
    }
    last = validateScriptSet(raw, ctx);
    if (last.valid && last.set) return { set: last.set, issues: last.issues, attempts: attempt, degraded: false };
    if (attempt < MAX_ATTEMPTS) user = buildRepairUser(base, raw, last.issues);
  }

  const issues = last?.issues ?? [];
  if (last?.set && !issues.some((i) => i.script === null && i.severity === 'error')) {
    const bad = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.script));
    const scripts = last.set.scripts.filter((_, i) => !bad.has(i));
    if (scripts.length >= 2) return { set: { ...last.set, scripts }, issues, attempts: MAX_ATTEMPTS, degraded: true };
  }
  throw new ScriptGenerationError('Could not produce scripts that pass the quality checks.', issues);
}
