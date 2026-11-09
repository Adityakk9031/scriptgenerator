# ScriptGen

Generates natural, spoken scripts of about 60 seconds for **Instagram Reels** and **TikTok**, written around the first 15 seconds, then opens the script you pick in a built-in **teleprompter** so you can record it.

You describe your video. ScriptGen studies what is performing in that niche right now, reads what viewers say in the comments, and writes up to 3 scripts with different angles, each with an honest note on what to expect.

## How it works

1. **Brief:** you describe the video. If the audience, product, topic or budget is unclear, it asks at most 2 follow-up questions.
2. **Scrape:** Apify fetches popular videos for the topic.
3. **Score:** each video gets a Reel Score from views, engagement, views relative to followers, and recency. Ads and low-signal videos are dropped.
4. **Comments:** comments on the top 5 videos are sorted into viewer questions, doubts, buying signals and audience phrasing. Usernames are removed.
5. **Analyze:** a small OpenAI model extracts the patterns that are working.
6. **Write:** a larger OpenAI model writes the scripts.
7. **Check:** code verifies word counts, banned phrases, copied text and invented numbers, with one automatic repair attempt.
8. **Record:** one click opens the teleprompter.

## Setup

Requires Node 22 or newer, an [Apify](https://apify.com) token and an [OpenAI](https://platform.openai.com) API key.

```bash
npm install
```

Create a `.env` file in the project root (see `.env.example`):

```
APIFY_TOKEN=your_apify_token
OPENAI_API_KEY=your_openai_key
```

`.env` is gitignored. Keys are only used on the server and never reach the browser.

## Run

Start each of these in its own terminal:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Then open http://localhost:5173.

## Commands

| Command | What it does | Cost |
|---|---|---|
| `npm test` | Unit tests. Apify and OpenAI are mocked | Free |
| `npm run typecheck` | TypeScript check | Free |
| `npm run build:web` | Production build of the web app | Free |
| `npm run check:openai` | Confirms your models exist. Add `-- --probe --call` to also test the schemas and one real call | Under 1 cent with the flags |
| `npm run record:fixtures` | Records small real Apify samples | Real money, about $0.20 |
| `npm run smoke` | One real end-to-end generation. Add `-- --cached-only` to refuse any new paid scrape | Real money, see below |

## Cost per generation

Measured on real runs:

| Platform | Apify | OpenAI |
|---|---|---|
| Instagram | about $0.26 | about 3 cents |
| TikTok | about $0.40 | about 3 cents |

Scrapes are cached on disk per query per day in `data/cache/`, so repeating the same search on the same day costs nothing on Apify. Hashtags are chosen by the model and can change between runs, which causes a new scrape.

## Configuration

These optional `.env` values override the defaults:

| Variable | Default |
|---|---|
| `OPENAI_MODEL_ANALYZE` | `gpt-5.4-nano` |
| `OPENAI_MODEL_GENERATE` | `gpt-5.4-mini` |
| `APIFY_ACTOR_IG_DISCOVERY` | `apify/instagram-hashtag-scraper` |
| `APIFY_ACTOR_IG_REELS` | `apify/instagram-reel-scraper` |
| `APIFY_ACTOR_TIKTOK_VIDEOS` | `clockworks/free-tiktok-scraper` |
| `APIFY_ACTOR_IG_COMMENTS` | `apify/instagram-comment-scraper` |
| `APIFY_ACTOR_TIKTOK_COMMENTS` | `clockworks/tiktok-comments-scraper` |
| `PORT` | `3001` |

## Project layout

```
src/config/     environment loading
src/schemas/    zod types: Brief, Video, Comment, Script
src/apify/      Apify runner, cache, input builders, normalizers
src/openai/     OpenAI client with structured outputs
src/prompts/    prompts, JSON schemas, shared script rules
src/pipeline/   intake, scoring, comment mining, generation, validation
src/server/     Express API
src/web/        React UI and teleprompter
scripts/        fixture recording, OpenAI check, smoke test
tests/          unit tests and anonymized fixtures
```

`AGENT.md` holds the working rules and the script criteria. `PLAN.md` holds the research and the build plan.

## Status

This is a prototype for one local user, with no login or database.

Known limits:

- A complete real generation that returns finished scripts has not yet been confirmed.
- A generation can take a few minutes, and the page shows a timer but not live progress.
- Comment sorting uses English keyword rules, so other languages and Hinglish are handled poorly.
- Reel Score weights are a starting guess and have not been checked against real results.
- "What to expect" is an estimate from similar videos, not a prediction of views.
