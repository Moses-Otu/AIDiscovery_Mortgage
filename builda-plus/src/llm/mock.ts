import type { LLMProvider, StructuredRequest, StructuredResult } from './provider';

// Deterministic provider for tests: queued responses per task, still schema-validated.
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  calls: StructuredRequest<unknown>[] = [];
  constructor(private responses: Record<string, unknown[]>, private tokensPerCall = 0) {}
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const queue = this.responses[req.task];
    if (!queue || queue.length === 0) throw new Error(`No scripted response for task ${req.task}`);
    return { data: req.schema.parse(queue.shift()), usage: { inputTokens: this.tokensPerCall, outputTokens: 0, model: 'scripted' } };
  }
}
