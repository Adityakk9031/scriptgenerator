/**
 * Records tiny REAL samples from Apify so normalizers are built against actual field names.
 * Costs a few cents. Output goes to data/raw-samples/ (gitignored: raw data contains public usernames).
 * Never prints the API token; prints only item counts, field NAMES and the run cost.
 *
 *   npm run record:fixtures
 */
import { ApifyClient } from 'apify-client';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from '../src/config/env';

dotenv.config({ quiet: true });

const OUT_DIR = path.resolve('data', 'raw-samples');
const MAX_CHARGE_USD = 0.3; // hard cap per run
const TOPIC = 'skincare';

type Item = Record<string, unknown>;

const config = parseEnv(process.env);
const client = new ApifyClient({ token: config.apifyToken });

async function runStage(name: string, actorId: string, input: Record<string, unknown>, limit: number): Promise<Item[]> {
  console.log(`\n[${name}] actor=${actorId}`);
  try {
    const run = await client.actor(actorId).call(input, {
      waitSecs: 240,
      timeout: 240,
      maxTotalChargeUsd: MAX_CHARGE_USD,
      log: null, // silence the actor's streamed logs
    });
    if (run.status !== 'SUCCEEDED') {
      console.log(`  status=${run.status} (not recorded)`);
      return [];
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit });
    await writeFile(path.join(OUT_DIR, `${name}.json`), JSON.stringify(items, null, 2), 'utf8');
    const first = (items[0] ?? {}) as Item;
    // Note: usageTotalUsd lags right after a run; real cost is in the Apify console (Runs).
    console.log(`  items=${items.length} runId=${run.id}`);
    console.log(`  fields: ${Object.keys(first).join(', ')}`);
    return items as Item[];
  } catch (e) {
    console.log(`  FAILED: ${(e as Error).message.slice(0, 300)}`);
    return [];
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function igUrl(item: Item | undefined): string | undefined {
  if (!item) return undefined;
  const code = str(item.shortCode);
  return str(item.url) ?? (code ? `https://www.instagram.com/reel/${code}/` : undefined);
}

function tiktokUrl(item: Item | undefined): string | undefined {
  if (!item) return undefined;
  return str(item.webVideoUrl) ?? str((item.postPage as Item | undefined)?.url);
}

await mkdir(OUT_DIR, { recursive: true });

const ig = await runStage(
  'ig-discovery',
  config.actors.instagramDiscovery,
  { hashtags: [TOPIC], resultsType: 'reels', resultsLimit: 5 },
  5,
);
const tt = await runStage(
  'tiktok-videos',
  config.actors.tiktokVideos,
  { hashtags: [TOPIC], resultsPerPage: 5 },
  5,
);

const reelUrl = igUrl(ig[0]);
const ttUrl = tiktokUrl(tt[0]);
console.log(`\nreel url found: ${Boolean(reelUrl)}, tiktok url found: ${Boolean(ttUrl)}`);

if (reelUrl) {
  await runStage('ig-comments', config.actors.instagramComments, { directUrls: [reelUrl], resultsLimit: 10 }, 10);
  await runStage(
    'ig-reel-details',
    config.actors.instagramReels,
    { username: [reelUrl], resultsLimit: 1, includeSharesCount: true, includeTranscript: true },
    1,
  );
}
if (ttUrl) {
  await runStage('tiktok-comments', config.actors.tiktokComments, { postURLs: [ttUrl], commentsPerPost: 10 }, 10);
}

console.log('\nDone. Raw samples in data/raw-samples/');
