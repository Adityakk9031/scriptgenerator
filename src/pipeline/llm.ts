/**
 * The only thing the pipeline knows about the LLM. The OpenAI implementation arrives in step 6;
 * until then (and in unit tests) a fake implements this interface, so no paid calls happen.
 */
export interface StructuredRequest {
  /** `analyze` = cheap/nano tier, `generate` = mini tier (mapped to model IDs from config). */
  tier: 'analyze' | 'generate';
  system: string;
  user: string;
  schemaName: string;
  /** JSON Schema the response must satisfy (OpenAI Structured Outputs). */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface StructuredLLM {
  /** Returns the parsed JSON the model produced. Callers validate it with zod. */
  generate(req: StructuredRequest): Promise<unknown>;
}
