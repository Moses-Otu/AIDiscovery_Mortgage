import { SchemaValidationError, type LLMProvider, type LLMUsage, type StructuredRequest, type StructuredResult } from './provider';

export interface UsageEntry extends LLMUsage { discoveryId: string; task: string; at: Date }
export interface UsageLedger {
  spentTokens(discoveryId: string): Promise<number>;
  record(entry: UsageEntry): Promise<void>;
}

export class InMemoryUsageLedger implements UsageLedger {
  entries: UsageEntry[] = [];
  async spentTokens(id: string) {
    return this.entries.filter((e) => e.discoveryId === id).reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  }
  async record(e: UsageEntry) { this.entries.push(e); }
}

export class BudgetExceededError extends Error {}

// Wraps any provider with a per-discovery token cap and usage recording (brief §8.7).
export class BudgetedProvider implements LLMProvider {
  readonly name: string;
  constructor(private inner: LLMProvider, private ledger: UsageLedger, private opts: { discoveryId: string; maxTokensPerDiscovery: number }) {
    this.name = `budgeted:${inner.name}`;
  }
  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const spent = await this.ledger.spentTokens(this.opts.discoveryId);
    if (spent >= this.opts.maxTokensPerDiscovery) {
      throw new BudgetExceededError(`AI budget reached for discovery ${this.opts.discoveryId} (${spent} tokens)`);
    }
    try {
      const res = await this.inner.generateStructured(req);
      await this.ledger.record({ ...res.usage, discoveryId: this.opts.discoveryId, task: req.task, at: new Date() });
      return res;
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        await this.ledger.record({ ...err.usage, discoveryId: this.opts.discoveryId, task: req.task, at: new Date() });
      }
      throw err;
    }
  }
}
