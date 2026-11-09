import { fetchComments, fetchVideos, type ApifyDeps } from '../apify/service';
import { ANALYSIS_JSON_SCHEMA, ANALYZE_MAX_OUTPUT_TOKENS, ANALYZE_SYSTEM_PROMPT, Analysis, buildAnalyzeUser } from '../prompts/analyze';
import type { Comment } from '../schemas/comment';
import type { ResolvedBrief } from './followups';
import { mineComments, type CommentInsights } from './comments';
import { collectSources, generateScripts, type GenerateResult } from './generate';
import type { StructuredLLM } from './llm';
import { rankVideos, type ScoredVideo } from './score';
import type { Benchmarks } from './stats';

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

export interface PipelineDeps {
  llm: StructuredLLM;
  apify: ApifyDeps;
  now?: () => Date;
}

export interface PipelineResult extends GenerateResult {
  benchmarks: Benchmarks;
  stats: { videosScraped: number; videosUsed: number; paidExcluded: number; commentsMined: number; scrapeCached: boolean };
}

const MAX_SEARCH_TAGS = 3;

async function analyze(llm: StructuredLLM, resolved: ResolvedBrief, ranked: ScoredVideo[], insights: CommentInsights): Promise<Analysis> {
  const user = buildAnalyzeUser({ platform: resolved.brief.platform, topic: resolved.effective.topic, ranked, insights });
  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.generate({
      tier: 'analyze',
      system: ANALYZE_SYSTEM_PROMPT,
      user: user + note,
      schemaName: 'analysis',
      jsonSchema: ANALYSIS_JSON_SCHEMA,
      maxOutputTokens: ANALYZE_MAX_OUTPUT_TOKENS,
    });
    const parsed = Analysis.safeParse(out);
    if (parsed.success) return parsed.data;
    note = '\n\nYour previous answer did not match the schema limits. Return shorter, valid JSON.';
  }
  throw new PipelineError('Could not analyse the scraped videos.');
}

/** Scrape -> score -> comments of the best -> mine -> analyse -> write + validate scripts. */
export async function runPipeline(deps: PipelineDeps, resolved: ResolvedBrief): Promise<PipelineResult> {
  const { brief, effective } = resolved;
  const hashtags = (brief.hashtags.length > 0 ? brief.hashtags : [effective.topic.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()]).slice(0, MAX_SEARCH_TAGS);

  const { videos, cached } = await fetchVideos(deps.apify, { platform: brief.platform, hashtags });
  const rank = rankVideos(videos, { now: deps.now?.() ?? new Date() });
  if (rank.ranked.length === 0) throw new PipelineError('No usable videos were found for this topic. Try a broader topic.');

  // Comments are extra signal: a failed comment scrape should not lose the whole generation.
  let comments: Comment[] = [];
  try {
    comments = (await fetchComments(deps.apify, { platform: brief.platform, videos: rank.ranked.map((r) => r.video) })).comments;
  } catch {
    comments = [];
  }
  const insights = mineComments(comments);
  const analysis = await analyze(deps.llm, resolved, rank.ranked, insights);
  const sources = collectSources({ videos: rank.ranked.map((r) => r.video), comments, analysis });
  const result = await generateScripts(deps.llm, { resolved, analysis, benchmarks: rank.benchmarks, sources });

  return {
    ...result,
    benchmarks: rank.benchmarks,
    stats: { videosScraped: videos.length, videosUsed: rank.ranked.length, paidExcluded: rank.paidExcluded, commentsMined: insights.stats.kept, scrapeCached: cached },
  };
}
