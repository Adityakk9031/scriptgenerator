import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiskCache, stableStringify } from '../src/apify/cache';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'scriptgen-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('stableStringify', () => {
  it('ignores object key order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it('keeps array order significant', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('createDiskCache', () => {
  it('misses first, then hits without calling the fetcher again', async () => {
    const cache = createDiskCache(dir);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [{ n: 1 }];
    };
    const a = await cache.getOrFetch({ q: 'skincare' }, fetcher);
    const b = await cache.getOrFetch({ q: 'skincare' }, fetcher);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.data).toEqual([{ n: 1 }]);
    expect(calls).toBe(1);
  });

  it('treats different inputs as different entries', async () => {
    const cache = createDiskCache(dir);
    let calls = 0;
    const fetcher = async () => ++calls;
    await cache.getOrFetch({ q: 'a' }, fetcher);
    await cache.getOrFetch({ q: 'b' }, fetcher);
    expect(calls).toBe(2);
  });

  it('treats key order as irrelevant', async () => {
    const cache = createDiskCache(dir);
    let calls = 0;
    const fetcher = async () => ++calls;
    await cache.getOrFetch({ a: 1, b: 2 }, fetcher);
    const r = await cache.getOrFetch({ b: 2, a: 1 }, fetcher);
    expect(r.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('expires the next day', async () => {
    let current = new Date('2026-11-09T10:00:00Z');
    const cache = createDiskCache(dir, () => current);
    let calls = 0;
    const fetcher = async () => ++calls;
    await cache.getOrFetch('k', fetcher);
    current = new Date('2026-11-09T23:59:00Z');
    expect((await cache.getOrFetch('k', fetcher)).cached).toBe(true);
    current = new Date('2026-11-10T00:01:00Z');
    expect((await cache.getOrFetch('k', fetcher)).cached).toBe(false);
    expect(calls).toBe(2);
  });

  it('does not cache failures', async () => {
    const cache = createDiskCache(dir);
    await expect(cache.getOrFetch('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await readdir(dir).catch(() => [])).toHaveLength(0);
    const r = await cache.getOrFetch('k', async () => 'ok');
    expect(r).toEqual({ data: 'ok', cached: false });
  });

  it('recovers from a corrupt cache file by refetching', async () => {
    const cache = createDiskCache(dir);
    await cache.getOrFetch('k', async () => 'first');
    const [file] = await readdir(dir);
    await writeFile(path.join(dir, file!), '{not json', 'utf8');
    const r = await cache.getOrFetch('k', async () => 'second');
    expect(r).toEqual({ data: 'second', cached: false });
  });

  it('leaves no temp files behind', async () => {
    const cache = createDiskCache(dir);
    await cache.getOrFetch('k', async () => 1);
    const files = await readdir(dir);
    expect(files.every((f) => f.endsWith('.json'))).toBe(true);
  });
});
