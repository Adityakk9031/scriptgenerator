export interface RunOptions {
  /** Hard cap on items returned (and read from the dataset). */
  maxItems: number;
  timeoutSecs?: number;
  /** Apify-side spending cap for pay-per-result actors. */
  maxChargeUsd?: number;
}

export interface ApifyRunner {
  run(actorId: string, input: Record<string, unknown>, opts: RunOptions): Promise<unknown[]>;
}

/** The small slice of `ApifyClient` we use, so tests can fake it. The real client satisfies it. */
export interface ApifyClientLike {
  actor(id: string): {
    call(
      input: Record<string, unknown>,
      options: { waitSecs: number; timeout: number; maxTotalChargeUsd: number; log: null },
    ): Promise<{ id: string; status: string; defaultDatasetId: string }>;
  };
  dataset(id: string): { listItems(options: { limit: number }): Promise<{ items: unknown[] }> };
  run(id: string): { abort(): Promise<unknown> };
}

export class ApifyRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApifyRunError';
  }
}

export const DEFAULT_TIMEOUT_SECS = 240;
export const DEFAULT_MAX_CHARGE_USD = 0.5;

export function createApifyRunner(client: ApifyClientLike): ApifyRunner {
  return {
    async run(actorId, input, opts) {
      if (!Number.isInteger(opts.maxItems) || opts.maxItems < 1) {
        throw new ApifyRunError(`maxItems must be a positive integer (got ${opts.maxItems})`);
      }
      const timeout = opts.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;

      // `call` starts the run and polls until it finishes or `waitSecs` elapses.
      const run = await client.actor(actorId).call(input, {
        waitSecs: timeout,
        timeout,
        maxTotalChargeUsd: opts.maxChargeUsd ?? DEFAULT_MAX_CHARGE_USD,
        log: null, // never stream actor logs into our output
      });

      if (run.status === 'READY' || run.status === 'RUNNING') {
        await client.run(run.id).abort().catch(() => undefined); // stop paying for a run we gave up on
        throw new ApifyRunError(`Actor ${actorId} did not finish within ${timeout}s and was aborted.`);
      }
      if (run.status !== 'SUCCEEDED') {
        throw new ApifyRunError(`Actor ${actorId} finished with status ${run.status}.`);
      }

      const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: opts.maxItems });
      return items.slice(0, opts.maxItems); // enforce the cap even if the source ignores `limit`
    },
  };
}
