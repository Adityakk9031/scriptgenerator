import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createApifyDeps } from '../apify/client';
import type { AppConfig } from '../config/env';
import { LlmError, createOpenAIClient, createOpenAILLM, redactSecrets } from '../openai/client';
import { decideFollowUps } from '../pipeline/followups';
import { ScriptGenerationError } from '../pipeline/generate';
import { IntakeError, completeBrief, extractBrief } from '../pipeline/intake';
import { PipelineError, runPipeline, type PipelineDeps } from '../pipeline/run';
import { Brief } from '../schemas/brief';
import { Platform } from '../schemas/common';

const IntakeBody = z.object({ platform: Platform, text: z.string().min(1).max(5000) });
const GenerateBody = z.object({
  brief: Brief,
  answers: z.record(z.string(), z.string().max(2000)).default({}),
});

function defaultDeps(config: AppConfig): PipelineDeps {
  return {
    // low effort: reasoning tokens count against the output cap
    llm: createOpenAILLM(createOpenAIClient(config.openaiApiKey), {
      models: config.models,
      reasoningEffort: { analyze: 'low', generate: 'low' },
    }),
    apify: createApifyDeps(config),
  };
}

export function createApp(config: AppConfig, deps: PipelineDeps = defaultDeps(config)) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  // Never expose keys. Only non-secret info the UI/dev may want.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, models: config.models });
  });

  app.post('/api/intake', async (req: Request, res: Response) => {
    const body = IntakeBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Please describe your video and pick a platform.' });
      return;
    }
    const brief = await extractBrief(deps.llm, { platform: body.data.platform, rawText: body.data.text });
    res.json({ brief, questions: decideFollowUps(brief) });
  });

  app.post('/api/generate', async (req: Request, res: Response) => {
    const body = GenerateBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }
    const { brief, answers } = body.data;
    // questions are recomputed from the brief, so a client can never add a third one
    const resolved = await completeBrief(deps.llm, brief, decideFollowUps(brief), answers);
    res.json(await runPipeline(deps, resolved));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof IntakeError || err instanceof PipelineError) {
      res.status(422).json({ error: err.message });
    } else if (err instanceof ScriptGenerationError) {
      res.status(502).json({ error: err.message, issues: err.issues });
    } else if (err instanceof LlmError) {
      res.status(502).json({ error: `The AI model failed: ${err.message}` });
    } else {
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.error(message);
      res.status(500).json({ error: 'Something went wrong while generating. Please try again.' });
    }
  });

  return app;
}
