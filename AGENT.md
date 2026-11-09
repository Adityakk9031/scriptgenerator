# AGENT.md — ScriptGen (rules for any AI agent working in this repo)

## 1. Product in one paragraph
ScriptGen generates **spoken video scripts (~60 s) for Instagram Reels and TikTok**, with the **first 15 s engineered as the engagement window**
(everyone watches that part before deciding to scroll).
Flow: user writes a brief → we check it is clear (**ask ≤ 2 follow-up questions only if needed**) → we **scrape** what is performing in that niche (Apify)
→ we **analyze** it (OpenAI) → we return **3 distinct scripts**, each with a "what to expect" note → user picks one → one click opens a **teleprompter**
so they can record the video.

## 2. Working rules (non-negotiable)
1. **NEVER commit, push, branch, tag, or `git init` without the user's explicit permission in chat.** Ask first, every time. Prior approval does not carry over.
2. **Always follow a plan structure.**
   - Step 1: write/update a plan (what, why, files touched, how it will be tested).
   - Step 2: get the user's OK on the plan when it is new or changed in scope.
   - Step 3: execute **one step at a time**; mark each step done only after its tests pass.
3. **Test loop for every step:** write the unit test first (or alongside) → run → fix → re-run until green. Do not move on while red. Report real output; never claim "passes" without running it.
4. **Secrets:** `.env` holds `APIFY_TOKEN` and `OPENAI_API_KEY`. Never print, log, commit, or paste them in chat. Keys are used **server-side only** — never shipped to the browser. `.env` stays in `.gitignore`; `.env.example` has empty values.
5. **Cost discipline:** every Apify run has a hard item cap; every OpenAI call has `max_output_tokens`. Cache scraped datasets to disk so the same query is never paid for twice. Unit tests must **mock** Apify and OpenAI — no paid calls in tests. Live smoke tests / fixture recording are opt-in (`npm run smoke`) and need the user's go-ahead.
6. Keep it small. No features, abstractions, or UI polish beyond what is asked. Say what you did and what you did not verify.

## 3. Stack
- **TypeScript only** (strict). Node 22+. Runtime-validate all external data with `zod`.
- Server: small Node HTTP server (Express). Web: Vite + React + TS (plain CSS, no UI framework).
- Tests: `vitest`. Typecheck: `tsc --noEmit`.
- LLM layer: **OpenAI only** (official `openai` SDK, Responses API with Structured Outputs / `json_schema`).
- Scraping: `apify-client`. Start runs async + poll (sync endpoint has a 300 s hard timeout).
- Model IDs and Apify actor IDs come from env/config, never hard-coded in logic (they change).
- Actor output field names are **never guessed**: normalizers are built against recorded real sample fixtures.

## 4. Pipeline (token-minimal)
0. **Intake (nano-tier, 1 call):** extract the brief → `{topic, product, audience, budget, goal, tone, hashtags[], keywords[]}` with each field marked `clear | vague | missing`.
   **`decideFollowUps()` is plain TypeScript (not the LLM):** all four required fields clear → ask nothing; otherwise **at most 2 questions**
   (priority: audience → product → topic → budget; bundle related fields). Still-unknown fields get defaults shown as editable "Assumptions". Never a 3rd question.
1. **Scrape videos** (Apify: Instagram via `apify/instagram-hashtag-scraper` with `resultsType: "reels"`; TikTok via `clockworks/free-tiktok-scraper`; by topic hashtags/keywords) → raw items, capped (default 50), saved to `data/cache/`.
2. **Reel Score, in code (zero LLM tokens):** dedupe, drop low-signal, `score = 0.35·viewsNorm + 0.30·engagementRate + 0.20·outlier + 0.15·recency`
   (`engagementRate = (likes + 2·comments + 3·shares) / views`; `outlier = views / author followers`; weights live in one config). Keep top ~15, compute niche benchmarks (median / top-quartile views, rates).
   **Missing signals are `null`, never 0:** Instagram hides some likes (`-1` → null) and has no follower counts (outlier = null); skip null terms and renormalise the remaining weights. Exclude paid/ad videos (`isPaid`) from organic benchmarks.
3. **Scrape comments of the top 5 scored videos only** (TikTok: ~40, sorted by like count; Instagram: ~30, which arrive newest-first with few likes, so mine them for questions/objections rather than rank by likes).
   Transcripts are **opt-in, default OFF, max 2 videos** (Instagram transcript add-on ≈ $0.10 per reel). **Mine in code:** dedupe, drop spam/emoji-only, **strip @handles (never send or store usernames)**,
   bucket into *questions* (unmet demand → angles), *objections* (pre-empt in script), *quotable phrases* (audience vocabulary), *intent signals* (save/share triggers). The LLM gets summaries, not raw dumps.
4. **Analyze (nano-tier):** from top videos + comment buckets extract patterns → small JSON (hook types, opening lines, structures, pacing, tone, audience vocabulary, questions/objections to address, benchmarks).
5. **Generate (mini-tier):** ONE call returns 3 scripts as structured JSON. Static system prompt first so OpenAI prompt caching applies.
6. **Validate in code:** schema, word counts per window, banned phrases, n-gram overlap vs. sources. Fail → one automatic repair retry, then surface the error.

## 5. SCRIPT CRITERIA (this section is the spec for the prompt — keep `src/prompts/` in sync)
**Platforms:** Instagram Reels and TikTok only. Output is a **spoken script for one creator talking/showing to camera** (~60 s).

**Timing model** (spoken pace ≈ 2.5 words/sec):
| Window | Seconds | Words | Job |
|---|---|---|---|
| Hook | 0–3 | ≤ 10 | stop the scroll |
| Hold | 3–15 | ~25 | stakes / proof / open loop |
| **Engagement window (Hook+Hold)** | **0–15** | **32–38 (hard cap 40)** | must work **standalone**: a viewer who only hears this must want to stay |
| Body | 15–50 | ~90 | 2–3 beats; a micro-hook ("but here's the catch…") every ~7–10 s so retention does not sag after 15 s |
| Close | 50–60 | ~20 | natural CTA (comment / save / follow / link) or loop back to the hook |
| **Total** | **≤ 60** | **140–155 (hard cap 160)** | |

**Engagement window rules (the most important part)**
- Hook types allowed: contrarian claim, specific number/result, "mistake" callout, curiosity gap, direct question to the viewer, bold before/after.
- The hook makes ONE promise. The Hold must raise the stakes or add proof and **open a loop** that only the Body closes. The Body must **deliver exactly what the hook promised**.
- No intro/greeting/"hey guys", no channel name, no throat-clearing in the first 15 s.

**Natural voice (must sound spoken, not written)**
- Contractions, 2nd person ("you"), short sentences (≤ 12 words), plain words.
- Read-aloud test: no sentence awkward to say in one breath.
- NO clichés/openers: "In today's fast-paced world", "Let me tell you", "Game-changer", "Unlock", "Dive into", "Here's the thing", "Hey guys". NO emojis, hashtags, stage directions, or markdown inside the spoken text.
- Visual/caption cues go in a separate `on_screen_text` field (many viewers watch sound-off), never in the spoken lines.
- Match the brief: audience vocabulary, product **price point/budget** (premium vs. affordable changes tone, claims and CTA), industry norms (beauty ≠ tech).

**Originality & honesty**
- Learn patterns from scraped videos; **never copy** wording (no run of > 5 identical words from any source caption/transcript/comment).
- **Use the comment insights:** at least one script should answer a top audience *question*, and each script should pre-empt the top *objection* where relevant; borrow the audience's vocabulary, not their sentences. Never reference or quote commenters.
- **Never invent** stats, results, testimonials, medical/skin/financial claims, or personal facts. Use only data from the scrape or the user's brief; use `[brackets]` for things the user must fill in.

**Variety** — return **3 genuinely different scripts** (different angle AND hook type), e.g. *Bold/Contrarian*, *Story/Personal*, *Practical/Quick-win*. Each includes:
`label`, `hook_type`, `segments` {hook, hold, body[], close} (spoken lines), `on_screen_text[]`, `word_count_total`, `word_count_window`, `est_seconds`,
`why_it_works` (tied to a pattern seen in the data), `expected_response`, `best_for`, `risk`, plus the `assumptions` used.

**Expected response (must be honest)**
- Never promise view counts. Give a **relative profile** (which of views-reach / comments / saves / shares / replays this style tends to drive) plus a
  **benchmark from the scraped sample** (e.g. "similar videos in this niche: median ~X views, top quartile ~Y, comment rate ~Z%"), clearly labelled an *estimate*, not a guarantee.

## 6. Follow-up question rules
- Required brief fields: **topic/industry, product/offer (or "none – personal brand/educational"), target audience, budget/price point.**
- If the user's brief already covers them → **ask nothing.**
- Otherwise ask **≤ 2 questions total**, referencing what the user already wrote; bundle related gaps; priority audience → product → topic → budget.
- Unanswered / skipped → use defaults and show them as editable assumptions. Never ask a 3rd question.

## 7. Repo layout (target)
```
.env  .env.example  AGENT.md  PLAN.md
src/server/      express app, routes
src/apify/       client wrapper, actor configs, cache, IG/TikTok normalizers
src/pipeline/    intake (+decideFollowUps), score, comments (mining), analyze, generate, validate
src/prompts/     system prompts + JSON schemas (versioned)
src/web/         React UI (Brief, FollowUps, Scripts, Teleprompter)
tests/           vitest unit tests (mocks for Apify/OpenAI) + fixtures/
data/cache/      scraped datasets (gitignored)
```
