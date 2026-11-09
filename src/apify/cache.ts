import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CacheResult<T> {
  data: T;
  cached: boolean;
}

export interface DiskCache {
  /** Returns the cached value for today + these key parts, or runs `fetcher`, stores and returns it. */
  getOrFetch<T>(keyParts: unknown, fetcher: () => Promise<T>): Promise<CacheResult<T>>;
}

/** JSON.stringify with sorted object keys, so equal inputs always give the same key. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * File cache, one JSON file per (day, key). Same query on the same day costs nothing.
 * Failed fetches are never cached; a corrupt file is treated as a miss.
 */
export function createDiskCache(dir: string, now: () => Date = () => new Date()): DiskCache {
  return {
    async getOrFetch<T>(keyParts: unknown, fetcher: () => Promise<T>): Promise<CacheResult<T>> {
      const day = now().toISOString().slice(0, 10);
      const hash = createHash('sha256').update(stableStringify({ day, keyParts })).digest('hex').slice(0, 32);
      const file = path.join(dir, `${hash}.json`);

      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { data?: T };
        if (parsed && 'data' in parsed) return { data: parsed.data as T, cached: true };
      } catch {
        // miss: file absent or unreadable/corrupt
      }

      const data = await fetcher();
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: now().toISOString(), data }), 'utf8');
      await rename(tmp, file);
      return { data, cached: false };
    },
  };
}
