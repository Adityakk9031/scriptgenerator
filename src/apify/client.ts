import { ApifyClient } from 'apify-client';
import path from 'node:path';
import type { AppConfig } from '../config/env';
import { createDiskCache } from './cache';
import { createApifyRunner } from './runner';
import type { ApifyDeps } from './service';

/** Wires the real Apify client + disk cache. Passing the real client here also type-checks it against ApifyClientLike. */
export function createApifyDeps(config: AppConfig, cacheDir = path.resolve('data', 'cache')): ApifyDeps {
  return {
    runner: createApifyRunner(new ApifyClient({ token: config.apifyToken })),
    cache: createDiskCache(cacheDir),
    actors: config.actors,
  };
}
