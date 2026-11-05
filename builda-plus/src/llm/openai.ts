import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { SchemaValidationError, type LLMProvider, type StructuredRequest, type StructuredResult } from './provider';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const model = opts.model ?? process.env.OPENAI_MODEL;
    if (!model) throw new Error('OPENAI_MODEL is not set');
    this.client = new OpenAI({ apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY });
    this.model = model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const { $schema: _ignored, ...schema } = zodToJsonSchema(req.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      ...req.messages,
    ];
    let inputTokens = 0, outputTokens = 0, issues = '';

    for (let attempt = 0; attempt < (req.maxAttempts ?? 2); attempt++) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema, strict: false } },
        max_completion_tokens: req.maxOutputTokens ?? 4000,
      });
      inputTokens += res.usage?.prompt_tokens ?? 0;
      outputTokens += res.usage?.completion_tokens ?? 0;
      const content = res.choices[0]?.message?.content ?? '';

      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { parsed = undefined; issues = 'Output was not valid JSON.'; }
      if (parsed !== undefined) {
        const result = req.schema.safeParse(parsed);
        if (result.success) return { data: result.data, usage: { inputTokens, outputTokens, model: this.model } };
        issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      }
      // Our validator, not the model, decides whether output is acceptable.
      messages.push({ role: 'assistant', content }, { role: 'user', content: `Your output failed validation: ${issues}. Return only corrected JSON.` });
    }
    throw new SchemaValidationError(req.task, issues, { inputTokens, outputTokens, model: this.model });
  }
}
