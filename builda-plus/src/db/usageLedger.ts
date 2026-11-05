import { withFirmContext, type Db } from './pool';
import type { UsageEntry, UsageLedger } from '../llm/budget';

// Durable AI usage ledger. Each record commits on its own, so spend is counted even
// if the turn that caused it later fails to save.
export class PgUsageLedger implements UsageLedger {
  constructor(private db: Db, private orgId: string) {}

  async spentTokens(discoveryId: string): Promise<number> {
    return withFirmContext(this.db, { orgId: this.orgId }, async (tx) => {
      const r = await tx.query(
        'select coalesce(sum(input_tokens + output_tokens), 0)::bigint as n from ai_usage where discovery_id = $1', [discoveryId]);
      return Number(r.rows[0].n);
    });
  }

  async record(e: UsageEntry): Promise<void> {
    await withFirmContext(this.db, { orgId: this.orgId }, (tx) => tx.query(
      `insert into ai_usage (org_id, discovery_id, task, model, input_tokens, output_tokens, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [this.orgId, e.discoveryId, e.task, e.model, e.inputTokens, e.outputTokens, e.at]));
  }
}
