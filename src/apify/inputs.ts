/**
 * Actor input builders. Field names come from the actors' real input schemas (checked 2026-11-09):
 *  - apify/instagram-hashtag-scraper: hashtags, resultsType ("reels"), resultsLimit
 *  - clockworks/free-tiktok-scraper:  hashtags, resultsPerPage
 *  - apify/instagram-comment-scraper: directUrls, resultsLimit
 *  - clockworks/tiktok-comments-scraper: postURLs, commentsPerPost
 */

export const LIMITS = {
  /** Videos fetched per topic search. */
  videos: 50,
  /** Comments kept per video. */
  igCommentsPerVideo: 30,
  ttCommentsPerVideo: 40,
  /** Only the best-scored videos get their comments scraped. */
  topVideosForComments: 5,
} as const;

/** Spread a total limit across several hashtags (the actors apply the limit per hashtag). */
export const perTagLimit = (total: number, tagCount: number): number => Math.max(1, Math.ceil(total / Math.max(1, tagCount)));

export function igDiscoveryInput(hashtags: string[], total: number): Record<string, unknown> {
  return { hashtags, resultsType: 'reels', resultsLimit: perTagLimit(total, hashtags.length) };
}

export function tiktokVideosInput(hashtags: string[], total: number): Record<string, unknown> {
  return { hashtags, resultsPerPage: perTagLimit(total, hashtags.length) };
}

export function igCommentsInput(urls: string[], perVideo: number): Record<string, unknown> {
  return { directUrls: urls, resultsLimit: perVideo };
}

export function tiktokCommentsInput(urls: string[], perVideo: number): Record<string, unknown> {
  return { postURLs: urls, commentsPerPost: perVideo };
}
