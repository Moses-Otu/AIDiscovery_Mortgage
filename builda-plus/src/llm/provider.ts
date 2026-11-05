import type { z } from 'zod';

// Provider abstraction (brief §8.7). Nothing outside src/llm knows which vendor is used.
export interface LLMMessage { role: 'user' | 'assistant'; content: string }
export interface LLMUsage { inputTokens: number; outputTokens: number; model: string }

export interface StructuredRequest<T> {
  task: string;              // e.g. 'interview.interpret' — used for usage accounting and audit
  system: string;
  messages: LLMMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
  maxAttempts?: number;
}
export interface StructuredResult<T> { data: T; usage: LLMUsage }

export interface LLMProvider {
  readonly name: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class SchemaValidationError extends Error {
  constructor(public task: string, public issues: string, public usage: LLMUsage) {
    super(`LLM output for "${task}" failed schema validation: ${issues}`);
  }
}
