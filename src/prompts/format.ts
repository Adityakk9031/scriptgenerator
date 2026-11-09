import type { ScoredVideo } from '../pipeline/score';
import type { Benchmarks } from '../pipeline/stats';
import type { CommentInsights, MinedComment } from '../pipeline/comments';

/**
 * Turns data into compact prompt text. Everything scraped (captions, transcripts, comments) is untrusted:
 * it is sanitised here and always placed inside clearly-marked DATA blocks.
 */

/** Strip things that could break out of a data block or waste tokens; cap the length. */
export function sanitizeForPrompt(text: string, maxChars: number): string {
  const clean = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ') // control chars
    .replace(/"""/g, "'''") // our data-block delimiter
    .replace(/```/g, "'''")
    .replace(/https?:\/\/\S+|www\.\S+/gi, '') // links
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Captions list hashtags separately; drop the #tags from the text to save tokens. */
export const stripHashtags = (text: string): string => text.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim();

/** 1234 -> "1.2k", 45015 -> "45k", 4_700_000 -> "4.7M". Rolls over to M before it would print "1000k". */
export function formatCount(n: number): string {
  const fmt = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ''));
  if (n >= 999_500) return `${fmt(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmt(n / 1_000)}k`;
  return String(n);
}

const pct = (r: number | null): string => (r === null ? 'n/a' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`);
const count = (n: number | null): string => (n === null ? 'n/a' : formatCount(n));

export function formatBenchmarks(b: Benchmarks): string {
  if (b.sampleSize === 0 || b.views === null) return 'Niche benchmarks: not available (no usable organic videos).';
  return [
    `Niche benchmarks (sample of ${b.sampleSize} organic videos; estimates, not guarantees):`,
    `- views: median ${formatCount(Math.round(b.views.median))}, top quartile (75th percentile) ${formatCount(Math.round(b.views.p75))}, best ${formatCount(b.views.max)}`,
    `- typical rates per view: likes ${pct(b.likeRate)}, comments ${pct(b.commentRate)}, shares ${pct(b.shareRate)}`,
    `- median video length: ${b.medianDurationSec === null ? 'n/a' : `${Math.round(b.medianDurationSec)}s`}`,
  ].join('\n');
}

/** One compact line per ranked video. */
export function formatVideoLine(rank: number, s: ScoredVideo): string {
  const v = s.video;
  const caption = sanitizeForPrompt(stripHashtags(v.caption), 220);
  const parts = [
    `#${rank}`,
    `views ${formatCount(v.views)}`,
    `likes ${count(v.likes)}`,
    `comments ${formatCount(v.comments)}`,
    `shares ${count(v.shares)}`,
    `length ${v.durationSec === null ? 'n/a' : `${Math.round(v.durationSec)}s`}`,
    `score ${s.score.toFixed(2)}`,
  ];
  const lines = [parts.join(' | '), `   caption: ${caption || '(none)'}`];
  if (v.hashtags.length > 0) lines.push(`   tags: ${v.hashtags.slice(0, 6).join(', ')}`);
  if (v.transcript) lines.push(`   spoken opening: ${sanitizeForPrompt(v.transcript, 260)}`);
  return lines.join('\n');
}

const formatMined = (title: string, list: MinedComment[]): string =>
  list.length === 0
    ? `${title}: (none)`
    : `${title}:\n${list.map((m) => `- (${m.likes} likes${m.count > 1 ? `, x${m.count}` : ''}) ${sanitizeForPrompt(m.text, 160)}`).join('\n')}`;

export function formatCommentInsights(i: CommentInsights): string {
  return [
    formatMined('Questions viewers ask', i.questions),
    formatMined('Doubts / objections', i.objections),
    formatMined('Buying / saving / sharing signals', i.intent),
    formatMined("Viewers' own phrasing", i.quotable),
  ].join('\n');
}
