import { describe, expect, it } from 'vitest';
import { ApifyRunError, createApifyRunner, type ApifyClientLike } from '../src/apify/runner';

interface Fake {
  client: ApifyClientLike;
  calls: { actorId: string; input: unknown; options: Record<string, unknown> }[];
  aborted: string[];
  listLimits: number[];
}

function fakeClient(opts: { status?: string; items?: unknown[] }): Fake {
  const fake: Fake = { calls: [], aborted: [], listLimits: [], client: undefined as unknown as ApifyClientLike };
  fake.client = {
    actor: (actorId) => ({
      call: async (input, options) => {
        fake.calls.push({ actorId, input, options });
        return { id: 'run1', status: opts.status ?? 'SUCCEEDED', defaultDatasetId: 'ds1' };
      },
    }),
    dataset: () => ({
      listItems: async ({ limit }) => {
        fake.listLimits.push(limit);
        return { items: opts.items ?? [] }; // deliberately ignores `limit`, like a misbehaving source
      },
    }),
    run: (id) => ({
      abort: async () => {
        fake.aborted.push(id);
      },
    }),
  };
  return fake;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe('createApifyRunner', () => {
  it('returns dataset items for a succeeded run', async () => {
    const f = fakeClient({ items: many(3) });
    const items = await createApifyRunner(f.client).run('a/b', { x: 1 }, { maxItems: 10 });
    expect(items).toHaveLength(3);
    expect(f.calls[0]!.actorId).toBe('a/b');
    expect(f.calls[0]!.input).toEqual({ x: 1 });
  });

  it('enforces the item cap (limit passed AND result sliced)', async () => {
    const f = fakeClient({ items: many(100) });
    const items = await createApifyRunner(f.client).run('a/b', {}, { maxItems: 5 });
    expect(f.listLimits).toEqual([5]);
    expect(items).toHaveLength(5);
  });

  it('passes spend and time caps, with safe defaults, and silences logs', async () => {
    const f = fakeClient({ items: [] });
    const runner = createApifyRunner(f.client);
    await runner.run('a/b', {}, { maxItems: 1 });
    expect(f.calls[0]!.options).toMatchObject({ waitSecs: 240, timeout: 240, maxTotalChargeUsd: 0.5, log: null });
    await runner.run('a/b', {}, { maxItems: 1, timeoutSecs: 60, maxChargeUsd: 0.1 });
    expect(f.calls[1]!.options).toMatchObject({ waitSecs: 60, timeout: 60, maxTotalChargeUsd: 0.1 });
  });

  it('throws on failed / timed-out / aborted runs without reading the dataset', async () => {
    for (const status of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
      const f = fakeClient({ status, items: many(2) });
      await expect(createApifyRunner(f.client).run('a/b', {}, { maxItems: 5 })).rejects.toThrow(status);
      expect(f.listLimits).toHaveLength(0);
    }
  });

  it('aborts a run that is still running when the wait expires', async () => {
    const f = fakeClient({ status: 'RUNNING' });
    await expect(createApifyRunner(f.client).run('a/b', {}, { maxItems: 5 })).rejects.toBeInstanceOf(ApifyRunError);
    expect(f.aborted).toEqual(['run1']);
  });

  it('rejects an invalid maxItems before calling Apify', async () => {
    const f = fakeClient({});
    for (const bad of [0, -1, 1.5]) {
      await expect(createApifyRunner(f.client).run('a/b', {}, { maxItems: bad })).rejects.toThrow('maxItems');
    }
    expect(f.calls).toHaveLength(0);
  });
});
