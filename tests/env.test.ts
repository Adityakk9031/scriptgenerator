import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/config/env';

const KEYS = { APIFY_TOKEN: 'apify_test_token_123', OPENAI_API_KEY: 'sk-test-secret-456' };

describe('parseEnv', () => {
  it('returns config with defaults when only the two keys are set', () => {
    const cfg = parseEnv(KEYS);
    expect(cfg.apifyToken).toBe(KEYS.APIFY_TOKEN);
    expect(cfg.openaiApiKey).toBe(KEYS.OPENAI_API_KEY);
    expect(cfg.models.analyze).toBe('gpt-5.4-nano');
    expect(cfg.models.generate).toBe('gpt-5.4-mini');
    expect(cfg.actors.instagramDiscovery).toBe('apify/instagram-hashtag-scraper');
    expect(cfg.actors.instagramReels).toBe('apify/instagram-reel-scraper');
    expect(cfg.port).toBe(3001);
  });

  it('throws EnvError naming both keys when none are set', () => {
    try {
      parseEnv({});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).missing).toEqual(['APIFY_TOKEN', 'OPENAI_API_KEY']);
      expect((e as Error).message).toContain('.env');
    }
  });

  it('treats empty and whitespace-only values as missing', () => {
    expect(() => parseEnv({ APIFY_TOKEN: '', OPENAI_API_KEY: '   ' })).toThrow(EnvError);
  });

  it('reports only the key that is missing', () => {
    try {
      parseEnv({ APIFY_TOKEN: KEYS.APIFY_TOKEN });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as EnvError).missing).toEqual(['OPENAI_API_KEY']);
    }
  });

  it('applies overrides for models, actors and port', () => {
    const cfg = parseEnv({
      ...KEYS,
      OPENAI_MODEL_GENERATE: 'my-model',
      APIFY_ACTOR_TIKTOK_VIDEOS: 'someone/tiktok',
      PORT: '4100',
    });
    expect(cfg.models.generate).toBe('my-model');
    expect(cfg.actors.tiktokVideos).toBe('someone/tiktok');
    expect(cfg.port).toBe(4100);
  });

  it('falls back to defaults for blank optional values', () => {
    const cfg = parseEnv({ ...KEYS, OPENAI_MODEL_ANALYZE: '  ', PORT: '' });
    expect(cfg.models.analyze).toBe('gpt-5.4-nano');
    expect(cfg.port).toBe(3001);
  });

  it('rejects an invalid PORT without leaking secret values', () => {
    try {
      parseEnv({ ...KEYS, PORT: 'not-a-number' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PORT');
      expect(msg).not.toContain(KEYS.APIFY_TOKEN);
      expect(msg).not.toContain(KEYS.OPENAI_API_KEY);
    }
  });

  it('never includes secret values in the missing-key error', () => {
    try {
      parseEnv({ APIFY_TOKEN: KEYS.APIFY_TOKEN });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(KEYS.APIFY_TOKEN);
    }
  });
});
