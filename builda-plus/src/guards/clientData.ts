// Deterministic client-data detector (brief §10). Runs BEFORE any text reaches the LLM.
// 'definite' => stop interview and escalate. 'possible' => ask participant to rephrase.
export type Severity = 'definite' | 'possible';
export interface ClientDataFinding { kind: string; severity: Severity }
export interface ClientDataScan { definite: boolean; possible: boolean; findings: ClientDataFinding[]; redacted: string }

const PATTERNS: { kind: string; severity: Severity; re: RegExp }[] = [
  { kind: 'national_insurance_number', severity: 'definite', re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi },
  { kind: 'email_address', severity: 'definite', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { kind: 'uk_mobile', severity: 'definite', re: /(?:\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3}\b/g },
  { kind: 'uk_landline', severity: 'definite', re: /(?:\+44\s?|\b0)[12]\d{2,3}\s?\d{3}\s?\d{3,4}\b/g },
  { kind: 'sort_code', severity: 'definite', re: /\b\d{2}-\d{2}-\d{2}\b/g },
  { kind: 'titled_name', severity: 'definite', re: /\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?/g },
  { kind: 'uk_postcode', severity: 'possible', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g },
  { kind: 'account_number', severity: 'possible', re: /\b\d{8}\b/g },
  { kind: 'date_of_birth_like', severity: 'possible', re: /\b\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}\b/g },
];

export function scanForClientData(text: string): ClientDataScan {
  const findings: ClientDataFinding[] = [];
  let redacted = text;
  for (const p of PATTERNS) {
    if (new RegExp(p.re.source, p.re.flags).test(text)) {
      findings.push({ kind: p.kind, severity: p.severity });
      redacted = redacted.replace(new RegExp(p.re.source, p.re.flags), `[REDACTED:${p.kind}]`);
    }
  }
  return {
    definite: findings.some((f) => f.severity === 'definite'),
    possible: findings.some((f) => f.severity === 'possible'),
    findings,
    redacted,
  };
}
