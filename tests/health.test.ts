import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createApp } from '../src/server/app';

const cfg = parseEnv({ APIFY_TOKEN: 'apify_test_token_123', OPENAI_API_KEY: 'sk-test-secret-456' });

describe('GET /api/health', () => {
  it('returns ok and the configured model names', async () => {
    const res = await request(createApp(cfg)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toEqual({ analyze: 'gpt-5.4-nano', generate: 'gpt-5.4-mini' });
  });

  it('never leaks API keys', async () => {
    const res = await request(createApp(cfg)).get('/api/health');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('apify_test_token_123');
    expect(text).not.toContain('sk-test-secret-456');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(createApp(cfg)).get('/api/nope');
    expect(res.status).toBe(404);
  });
});
