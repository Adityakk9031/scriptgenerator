import express from 'express';
import type { AppConfig } from '../config/env';

export function createApp(config: AppConfig) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Never expose keys. Only non-secret info the UI/dev may want.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, models: config.models });
  });

  return app;
}
