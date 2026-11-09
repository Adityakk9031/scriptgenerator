import type { Comment } from '../schemas/comment';

/**
 * Comment mining, in plain code (zero LLM tokens). Turns raw comments into small, anonymous insight lists:
 *   intent     - buying / saving / sharing signals ("link?", "sent this to my sister", "how much")
 *   objections - doubts the script should pre-empt ("looks fake", "doesn't work on oily skin")
 *   questions  - unmet demand = script angles ("does this work on dry skin?")
 *   quotable   - the audience's own vocabulary
 * Privacy: handles are already redacted upstream; here we also drop comments that contain emails or phone numbers.
 */

export type Bucket = 'intent' | 'objection' | 'question' | 'quotable';

export interface MinedComment {
  text: string;
  likes: number;
  /** How many near-identical comments were merged into this one. */
  count: number;
}

export interface CommentInsights {
  intent: MinedComment[];
  objections: MinedComment[];
  questions: MinedComment[];
  quotable: MinedComment[];
  stats: { input: number; kept: number; dropped: number; byBucket: Record<Bucket, number> };
}

export interface MineOptions {
  maxIntent: number;
  maxObjections: number;
  maxQuestions: number;
  maxQuotable: number;
  maxChars: number;
}

export const DEFAULT_MINE_OPTIONS: MineOptions = {
  maxIntent: 5,
  maxObjections: 5,
  maxQuestions: 10,
  maxQuotable: 8,
  maxChars: 160,
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const HANDLE = /@[\p{L}\p{N}._]+/gu;
const SPAM =
  /\b(follow (me|back)|check (out )?my|dm me|link in (my )?bio|giveaway|f4f|l4l|sub(scribe)? to my|earn \$|crypto|whatsapp|telegram)\b/i;
/** Content-free reactions; dropped when they are the entire comment. */
const NOISE = new Set(['first', 'second', 'third', 'lol', 'lmao', 'haha', 'nice', 'wow', 'omg', 'cool', 'yes', 'no', 'ok', 'okay', 'same', 'true', 'fire', 'hi', 'hello']);

const INTENT =
  /\b(link|how much|price|where\b.{0,15}\b(buy|get|find|order|purchase)|need (this|it|these|the|that)|i need|i want|want (this|it|these)|sen[dt]\w* (this|it)|tagg?(ed|ing)?\b|saving (this|it)|saved|bookmark\w*|shar(e|ed|ing) (this|it)|take my money|part (2|two)|more (of|like) this|name of (the|this)|what('?s| is) (the|this) (name|brand|product)|which (brand|product)|promo code|discount code|drop the)/i;
const OBJECTION =
  /\b(fake|scam|doesn'?t work|does not work|didn'?t work|did not work|not worth|overpriced|too expensive|waste of|clickbait|sponsored|just an ad|an ad\b|paid (ad|promo)|lying|lies|sus\b|skeptical|sceptical|doubt|allergic|broke me out|made me break out|irritat\w+|side effects?|disappointed|not for me|too good to be true|placebo|no way)/i;
const QUESTION_START = /^(how|what|why|where|when|which|who|can|could|does|do|is|are|will|would|should)\b/i;

const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
const normKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Cleaned comment text, or null if it is noise / spam / unsafe to keep. */
export function cleanCommentText(raw: string): string | null {
  if (EMAIL.test(raw)) return null; // must be checked BEFORE handle-stripping, which would turn "a@b.com" into "a"
  // Defence in depth: the normalizer already turns @handles into "@user"; strip any handle that slipped through.
  const t = raw.replace(HANDLE, '').replace(URL_RE, '').replace(/\s+/g, ' ').trim();
  if (!/\p{L}/u.test(t)) return null; // emoji-only or number-only
  if (t.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null;
  if (/\d{7,}/.test(t.replace(/[\s().-]/g, ''))) return null; // phone-number-like
  if (/(.)\1{5,}/u.test(t)) return null; // "aaaaaaa" spam
  if (SPAM.test(t)) return null;
  if (NOISE.has(normKey(t))) return null;
  return t;
}

/** Which insight bucket a (cleaned) comment belongs to. Priority: intent > objection > question > quotable. */
export function classifyComment(text: string): Bucket | null {
  if (INTENT.test(text)) return 'intent';
  if (OBJECTION.test(text)) return 'objection';
  if (text.includes('?') || (QUESTION_START.test(text) && wordCount(text) >= 3)) return 'question';
  const words = wordCount(text);
  if (words >= 4 && words <= 30) return 'quotable';
  return null;
}

const truncate = (t: string, max: number): string => (t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`);
const byLikes = (a: MinedComment, b: MinedComment): number => b.likes - a.likes || b.count - a.count || a.text.localeCompare(b.text);

export function mineComments(comments: Comment[], options: Partial<MineOptions> = {}): CommentInsights {
  const opt = { ...DEFAULT_MINE_OPTIONS, ...options };

  // 1) clean + dedupe near-identical comments (keep the most-liked wording, count the rest)
  const merged = new Map<string, MinedComment>();
  for (const c of comments) {
    const text = cleanCommentText(c.text);
    if (!text) continue;
    const key = normKey(text);
    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      if (c.likes > existing.likes) {
        existing.likes = c.likes;
        existing.text = text;
      }
    } else {
      merged.set(key, { text, likes: c.likes, count: 1 });
    }
  }

  // 2) bucket
  const buckets: Record<Bucket, MinedComment[]> = { intent: [], objection: [], question: [], quotable: [] };
  for (const m of merged.values()) {
    const b = classifyComment(m.text);
    if (b) buckets[b].push(m);
  }

  // 3) rank by likes, trim, shorten
  const top = (list: MinedComment[], max: number): MinedComment[] =>
    [...list].sort(byLikes).slice(0, max).map((m) => ({ ...m, text: truncate(m.text, opt.maxChars) }));

  const kept = Object.values(buckets).reduce((n, l) => n + l.length, 0);
  return {
    intent: top(buckets.intent, opt.maxIntent),
    objections: top(buckets.objection, opt.maxObjections),
    questions: top(buckets.question, opt.maxQuestions),
    quotable: top(buckets.quotable, opt.maxQuotable),
    stats: {
      input: comments.length,
      kept,
      dropped: comments.length - kept,
      byBucket: {
        intent: buckets.intent.length,
        objection: buckets.objection.length,
        question: buckets.question.length,
        quotable: buckets.quotable.length,
      },
    },
  };
}
