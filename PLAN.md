# PLAN.md — ScriptGen (Instagram Reels + TikTok) — research + build plan (awaiting approval)

Status: **research done, nothing built yet.** Revision 2 (2026-11-09): platforms changed from LinkedIn/X to **Instagram Reels + TikTok**; video length ≈ **60 s** with the **first 15 s as the engagement window**; added **follow-up-question intake**.
Revision 3 (2026-11-09): Apify's job is now explicitly three things — **(1) fetch top reels/videos for a topic, (2) fetch the popular comments on the best ones to learn what makes them engaging, (3) feed a computed "Reel Score" + comment insights to the LLM** (see B1b).
Prices are from third-party listings/aggregators — re-verify on the official pages before relying on them.

## A. What changed vs. revision 1
| Topic | Before | Now |
|---|---|---|
| Platforms | LinkedIn, X | **Instagram Reels, TikTok** (X dropped — I read "X, als Instagram" as a typo; tell me if X should stay) |
| Script length | ≤ 15 s total | **~60 s total (~150 words)**, with the **first 15 s (~35 words) written as its own self-contained "engagement window"** |
| Input | topic + platform | **Free-text brief → clarity check → at most 2 follow-up questions only if needed** |
| Scrape data | posts text | **Reels/TikTok videos: captions, hashtags, views, likes, comments, shares (+ optional transcripts of the top videos)** |
| "Expected response" | likes/comments benchmark | **Views/likes/comments/shares benchmarks from the scraped niche sample** (video platforms expose play counts, so this is more grounded) |

## B. Research findings

### B1. Apify — which actors (IG + TikTok)
| Need | Candidate | Price (listing) | Notes |
|---|---|---|---|
| Instagram Reels (profiles / hashtags / keywords) | [apify/instagram-reel-scraper](https://apify.com/apify/instagram-reel-scraper/api/mcp) | ~$2.30 / 1k reels | Official actor. **Unverified:** whether it accepts hashtag input |
| Instagram by hashtag | [apify/instagram-hashtag-scraper](https://apify.com/apify/instagram-hashtag-scraper/issues/scrape-reels-pIazxlZUshw4PX6Qu) | ~$2.30 / 1k | Official; use if reel-scraper lacks hashtag mode |
| Instagram cheap fallbacks | [khadinakbar Reels Scraper](https://apify.com/khadinakbar/instagram-reels-scraper/pricing) (profiles+hashtags+keywords), [sones](https://apify.com/sones/instagram-reels-scraper-lowcost) | from ~$0.90 / 1k | Community; reliability varies |
| TikTok hashtag/search/profile | [clockworks/free-tiktok-scraper](https://apify.com/clockworks/free-tiktok-scraper/pricing) ("TikTok Data Extractor") | ~$2–4 / 1k (sources disagree) | Very popular; hashtag support stated in listing. **Default pick** |
| TikTok pay-per-result alt | [apidojo/tiktok-scraper](https://apify.com/apidojo/tiktok-scraper?fpr=hs6s8) | PPR | Fallback |
| **Instagram comments** (popular comments on top reels) | [apify/instagram-comment-scraper](https://apify.com/apify/instagram-comment-scraper/pricing) (official) | ~$1.90–2.30 / 1k comments | Fallbacks: [apidojo PPR](https://apify.com/apidojo/instagram-comments-scraper/pricing), [memo23 ~$0.80/1k with replies + like counts](https://apify.com/memo23/apify-instagram-comments-scraper/reviews). **Unverified:** whether the official one returns comment like counts — fixture will tell |
| **TikTok comments** | [clockworks/tiktok-comments-scraper](https://apify.com/clockworks/tiktok-comments-scraper/pricing) | ~$0.50 / 1k comments | Fallback: [apidojo ~$0.30/1k](https://apify.com/apidojo/tiktok-comments-scraper). Returns comment text + hearts (field name unconfirmed) |
| **Spoken-script transcripts** | [automation-lab Video Transcript Scraper](https://apify.com/automation-lab/video-transcript-scraper) (TikTok/Reels/Shorts) | ~$0.05–0.14 / video | Gives the *actual words* of viral clips → best material for natural-sounding hooks |

**Cost reality per generation:** 50 videos ≈ $0.10–0.20; comments for the top 5 videos × ~40 comments (~200) ≈ $0.10–0.46; transcripts for the top 3 ≈ $0.15–0.40. **Total ≈ $0.35–1.00**, and $0 for scraping on a cache hit. Free plan ≈ $5/month credits ([pricing](https://apify.com/pricing)) ≈ 5–15 full runs.
**Open risk:** I could not confirm the output field names (play/like/comment/share counts) for any of these. Step 1 of the build therefore records a **tiny real sample run (≈5 items, a few cents, needs your go-ahead)** as a test fixture, and the normalizer is built against that — not guessed.

### B1b. The three Apify jobs and how the data reaches the LLM
**Job 1 — Find the popular reels for the topic.** Hashtag/keyword scrape (cap 50) → videos with caption, hashtags, views, likes, comments, shares, author followers, date.

**Job 2 — Learn *why* they engage, from the comment section.** Scoring happens first, then comments are scraped **only for the top 5 scored videos** (we never pay to scrape comments of losers). In code (no LLM tokens) we mine the comments:
- keep the ~40 most-liked comments per video, dedupe, drop spam / emoji-only / "first!" noise, **strip @handles** (privacy — usernames never reach the LLM or disk cache);
- bucket them: **questions** ("where do I buy it?", "does this work on oily skin?") = unmet demand → script angles; **objections/doubts** ("looks fake") = things the script must pre-empt; **reaction/quotable lines** (what people repeated or laughed at) = vocabulary and emotional triggers; **intent signals** ("need link", "sent to my friend") = what drives saves/shares.
The LLM receives these as a small summary (e.g. top 10 questions, top 5 objections, top phrases), not raw comment dumps.

**Job 3 — The "Reel Score" (ranks what to learn from).** Computed in TypeScript, unit-tested, weights tunable in one config object:
`score = 0.35·viewsNorm + 0.30·engagementRate + 0.20·outlier + 0.15·recency`
- `engagementRate = (likes + 2·comments + 3·shares) / views` (shares/saves weigh most because they drive reach)
- `outlier = views / author followers` (a small account with big views = the *content* worked, not the audience size)
- `viewsNorm` = log-scaled within this sample; `recency` decays over ~60 days so we learn from what works *now*
- Top ~15 by score go to the analyzer; top 5 get comment scraping; top 3 get transcripts (toggle).
Output also carries **niche benchmarks** (median / top-quartile views and rates) used for the honest "what to expect" estimate.

### B1c. Verified from real sample runs (2026-11-09, skincare, 5 items each)
| Finding | Consequence |
|---|---|
| `apify/instagram-reel-scraper` takes **usernames/URLs only** — no topic search | IG discovery = **`apify/instagram-hashtag-scraper`** (`resultsType: "reels"`, returns views, comments, **shares**, duration). Reel-scraper only for details of known reel URLs |
| IG **likes are hidden (`-1`) on some reels** (2 of 5) | `likes` is nullable; IG Reel Score uses views + comments + shares |
| IG actors return **no follower counts** | `outlier` = null for IG (weight redistributed); TikTok has `authorMeta.fans` |
| TikTok results include **ads** (`isAd`/`isSponsored`, 2 of 5) | New `isPaid` flag; ads excluded from organic benchmarks |
| TikTok comments carry real like counts (`diggCount`, up to 12,662) → true "popular comments" | Scrape ~40, sort by `diggCount` |
| IG comments come **newest-first with ~0–2 likes** — not "popular" | Mine IG comments for questions/objections regardless of likes (30/reel); don't expect a like-ranking |
| **IG transcript add-on cost ≈ $0.10 per reel** (the reel-scraper run was $0.0996 for 1 reel) | Transcripts become **opt-in, default OFF**, max 2 videos. TikTok exposes subtitle links for some videos at no extra scraper cost |
| Measured cost of the whole sample (5 runs) ≈ **$0.17**, of which ≈ $0.10 was the IG transcript | A full run without transcripts ≈ **$0.10–0.40** |

### B2. Using Apify efficiently
- Hard item cap + `timeoutSecs` on every run (default 50 videos).
- Sync endpoint dies at **300 s** ([docs](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-get.md)) → start async via `apify-client`, `waitForFinish`, check `status === 'SUCCEEDED'`, then `listItems({limit})` ([client docs](https://docs.apify.com/api/client/js/docs)).
- Disk cache keyed by `(actor, hashtags/keywords, day)` — same niche twice = $0 scraping.
- Filter in the actor input when possible (recent posts, min views) rather than paying for junk.
- Keep actor IDs in config — community actors break/rename.
- Search keywords/hashtags come from the intake step (one cheap LLM call), not from a second call.

### B3. OpenAI — model choice (token-cheap)
**GPT-5.4 nano** $0.20 in / $1.25 out per 1M (cached $0.02); **GPT-5.4 mini** $0.75 / $4.50 (cached $0.075); GPT-5.5 flagship $5 / $30 ([details](https://cloudprice.net/models/openai-gpt-5-4-nano), [overview](https://toolhalla.ai/blog/gpt-5-4-mini-nano-budget-ai-models-2026)).
- **Intake/gap-check + keyword extraction → nano**
- **Analyze scraped data → nano**
- **Write the 3 scripts → mini** (naturalness matters; a 60 s script is only ~200 tokens)
- IDs configurable via env and verified against `GET /v1/models` in the build.
- **≈ $0.01–0.02 per full generation.** Token savers: compress/dedupe/truncate in code, top-15 videos only, structured output, static system prompt first (prompt cache), one call for all 3 scripts, `max_output_tokens` caps.

### B4. Script craft for a 60 s Reel/TikTok where the first 15 s decides everything
(Practitioner consensus — no platform-official benchmark found; [hook→payoff](https://faceless.so/blog/hook-story-offer-for-high-retention-shorts-2), [first 3 seconds](https://dev.to/bulkdl/hook-engineering-the-science-of-the-first-3-seconds-in-short-form-video-2026-2jp9).)
- The decisive viewer decision is in the first ~3 s; the next ~12 s must give a reason to stay (stakes, proof, open loop).
- Body must **pay off exactly what the hook promised**; add a micro-hook every ~7–10 s so retention doesn't sag after 15 s.
- Sound-off viewing is common → scripts ship with on-screen caption lines.
- Last 10 s: CTA or loop back to the hook (replays help).

**Script timing model (2.5 words/sec):**
| Window | Seconds | Words | Job |
|---|---|---|---|
| Hook | 0–3 | ≤ 10 | stop the scroll |
| Hold | 3–15 | ~25 | stakes / proof / open loop — **hook+hold total 32–38 words** |
| Body | 15–50 | ~90 | 2–3 beats, micro-hook between beats |
| Close | 50–60 | ~20 | CTA or loop back to hook |
| **Total** | **≤ 60** | **140–155 (hard cap 160)** | |

## C. Intake + follow-up questions (new)
Goal: don't interrogate users who already gave enough; don't generate blind when they didn't.

**Four things a good script needs (the "brief"):**
1. **Topic / industry** (beauty, tech, fitness, food…)
2. **Product / offer to showcase or promote** (or "none — personal-brand / educational")
3. **Target audience** (who, age/interest/pain)
4. **Budget / price point** of the product (e.g. "₹499 budget skincare" vs "premium $200 gadget") — it changes tone, claims and CTA

**Flow:**
1. User writes a free-text brief + picks Instagram or TikTok.
2. **One nano call** extracts: `{topic, product, audience, budget, goal, tone, hashtags[], keywords[]}` and marks each field `clear | vague | missing`.
3. **Plain TypeScript (not the LLM) decides** what to ask — so it is deterministic and unit-testable:
   - All four `clear` → **skip questions, go straight to scraping/generating.**
   - Otherwise ask **at most 2 follow-up questions**, in priority order *audience → product → topic → budget*, **bundling related missing fields into one question** (e.g. "Who is this for, and what's their rough budget?").
   - Any field still unknown after the answers (or if the user clicks "Skip") gets a sensible default, shown as editable **"Assumptions"** chips on the results page. **Never a 3rd question.**
4. Questions are generated to reference what the user already wrote (not generic form labels).

*Interpretation note:* I read "2 follow-up questions" as "up to 2, only when needed". If you meant exactly 2 always, or 2 rounds, tell me.

## D. Ideas to make the product better (not in v1 unless you pick them)
1. **Transcripts of the top 3 videos** (B1) — I recommend including in v1 as a toggle (default on, ~$0.15–0.40/run) because it gives real spoken-hook examples.
2. **Creator voice**: scrape the user's own IG/TikTok profile captions/transcripts and match their style.
3. **Competitor mode**: scrape a rival's last 30 days, find what beats their own average ("outlier score" = views ÷ follower count).
4. **Hook bank**: save high-scoring hooks per niche for $0 reuse.
5. **A/B tracker**: user logs real views per script; feeds back into benchmarks.
6. **Caption/SRT export** from the teleprompter script.

## E. Proposed v1 scope
Brief → (maybe ≤2 questions) → scrape IG/TikTok niche videos → **Reel Score** → **scrape + mine comments of the top 5** → analyze → **3 scripts** (60 s each, engagement-window-first) with timeline + "what to expect" + assumptions → pick one → **Teleprompter**: sectioned text (Hook / Hold / Body / Close), 15 s marker, 60 s timer, auto-scroll speed, font size, mirror, 3-2-1 countdown, space = play/pause.
Local, single user, no auth, no DB (JSON cache on disk).

## F. Build steps (each = code + unit tests, loop until green; no commits without your OK)
| # | Step | Tests (mocked — no paid calls) |
|---|---|---|
| 0 | Scaffold: TS strict, vitest, Express, Vite/React, env loader (clear error if keys empty) | env loader; typecheck |
| 1 ✅ | Types + zod schemas: `Brief`, `Video`, `Comment`, `Script`/`ScriptSet`; **real 5-item samples recorded per platform → anonymized fixtures** (`npm run record:fixtures`, `scripts/make-fixtures.ts`) | schema accept/reject cases; fixture shape + privacy checks — **46 tests green** |
| 2 ✅ | Apify wrapper (`src/apify/`): runner (start + wait, spend/time/item caps, abort on timeout), day-keyed disk cache of **raw** actor output, input builders, `fetchVideos` / `fetchComments`, normalizers → `Video`, `Comment` (+ IG transcript normalizer; transcript fetching is not wired yet — opt-in later) | normalizers on real fixtures + edge cases, cache hit/miss/expiry/corruption, caps, mentions redacted, no username keys — **100 tests green** |
| 3 ✅ | Intake: prompt + extraction schema (`src/prompts/intake.ts`), `StructuredLLM` interface (`src/pipeline/llm.ts`), **`decideFollowUps(brief)` pure function** (max 2 Qs, related gaps bundled: audience+budget, product+topic), `resolveBrief` defaults/assumptions, `extractBrief` (1 retry), `completeBrief` (folds answers in, never a 3rd question) | table tests incl. all 81 status combos (≤2 questions, every gap covered once), defaults, retry/validation, skip → no LLM call — **143 tests green** |
| 4 | **Reel Score** (B1b formula, config weights), top-N selection, benchmark stats; then **comment mining** (dedupe, noise filter, bucket into questions / objections / quotable phrases / intent) after the comment scrape of the top 5 | score ordering (small-account outlier beats big-account same views), weight changes, recency decay, benchmark math, comment bucketing on fixture comments |
| 5 | Prompts + JSON schemas (analyze, generate) per AGENT.md §5 | schema validates sample output |
| 6 | OpenAI client (Responses API, structured outputs, token caps, model fallback) | mocked client; error paths |
| 7 | Validator: hook+hold 32–38 words, total ≤ 160 words / ≤ 60 s, banned clichés, n-gram overlap vs. sources, one auto-repair retry | pass/fail incl. 45-word opening, cliché, copied text |
| 8 | API: `POST /api/intake`, `POST /api/generate` | route tests w/ mocks |
| 9 | UI: brief form → follow-up card (only if needed) → 3 script cards with 0–15 s highlighted → select | component tests |
| 10 | Teleprompter view (one button from selected script) | scroll-speed math, section markers, timers |
| 11 | Opt-in live smoke test with your real keys (one small run) | manual, needs your go-ahead |

## G. Decisions I need from you
1. **Platforms:** Instagram Reels + TikTok only (X dropped) — correct?
2. **Script shape:** full ~60 s script whose first 15 s is the optimized engagement window — correct (vs. only writing the 15 s)?
3. **Follow-ups:** "up to 2 questions, only when info is missing, defaults for the rest" — OK?
4. **"Budget"** = the product's price point / audience spending level (not your video production budget) — correct?
5. **Transcripts of top videos in v1?** (recommended: yes, toggle, top 3)
6. **Stack:** Express + Vite/React + TypeScript + vitest — OK? **Models:** nano (intake/analysis) + mini (scripts) — OK?
7. **Language:** English only for v1?
8. **"Tracking"** — I read your "for tracking and making the good score" as: track each video's metrics and compute the Reel Score (B1b). If you meant tracking the user's *own* reels' results over time, that is idea D5 (A/B tracker) and I'd add it after v1 — which one?
9. Comment scraping scope: top **5** videos × top **~40** comments each OK (≈ $0.10–0.46/run)?
10. Paste your two keys into `.env` yourself (I never need to see them).
