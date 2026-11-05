import { z } from 'zod';
import { CLASSIFICATIONS, ROLES, STAGE_IDS, STAGES, type StageId } from '../domain/journey';
import type { Playbook, PlaybookCard, RegulatoryCheck, SourceRef, SourceSnapshot } from './playbook';

export type KnowledgeKind = 'card' | 'check' | 'source';
const lines = z.array(z.string().trim().min(1).max(600)).max(40);
const SourceRefSchema = z.object({ sourceKey: z.string().min(2).max(80), section: z.string().max(200).default('') });

export const CardContentSchema = z.object({
  title: z.string().trim().min(3).max(200),
  stageId: z.enum(STAGE_IDS),
  roles: z.array(z.enum(ROLES)).min(1),
  signs: lines, interviewQuestions: lines.min(1), infoToCollect: lines, metrics: lines,
  likelyClassification: z.enum(CLASSIFICATIONS),
  automationPatterns: lines, humanApproval: lines, regulatoryLimits: lines,
  owner: z.string().trim().min(2).max(200),
  sourceRefs: z.array(SourceRefSchema).max(20).default([]),
});

export const CheckContentSchema = z.object({
  title: z.string().trim().min(3).max(200),
  statement: z.string().trim().min(10).max(2000),
  appliesToStages: z.array(z.enum(STAGE_IDS)).min(1),
  appliesTo: z.enum(['any_change', 'automation']),
  requiredAction: z.string().trim().min(5).max(1000),
  owner: z.string().trim().min(2).max(200),
  sourceRefs: z.array(SourceRefSchema).min(1).max(20),      // a regulatory check must cite something
});

export const SourceContentSchema = z.object({
  title: z.string().trim().min(3).max(300),
  reference: z.string().trim().min(3).max(500),             // URL or formal citation
  publisher: z.string().trim().min(2).max(200),
  updatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  sections: lines,
  summary: z.string().trim().max(3000).default(''),
  owner: z.string().trim().min(2).max(200),
});

export const CONTENT_SCHEMAS = { card: CardContentSchema, check: CheckContentSchema, source: SourceContentSchema } as const;

export interface ApprovedItem { id: string; kind: KnowledgeKind; key: string; version: number; content: any; reviewedAt: string }

// The stages where regulated judgement happens must each be covered by an approved check before publishing.
export const REGULATED_STAGES: StageId[] = STAGE_IDS.filter((s) => STAGES[s].regulatedJudgement);

export function assembleRelease(version: string, items: ApprovedItem[]): { playbook: Playbook; errors: string[] } {
  const errors: string[] = [];
  const latest = new Map<string, ApprovedItem>();
  for (const i of items) {
    const k = `${i.kind}:${i.key}`;
    if (!latest.has(k) || latest.get(k)!.version < i.version) latest.set(k, i);
  }
  const of = (kind: KnowledgeKind) => [...latest.values()].filter((i) => i.kind === kind).sort((a, b) => a.key.localeCompare(b.key));
  const day = (iso: string) => iso.slice(0, 10);

  const sources: SourceSnapshot[] = of('source').map((i) => ({ key: i.key, ...i.content, lastReviewed: day(i.reviewedAt) }));
  const sourceKeys = new Set(sources.map((s) => s.key));
  const cards: PlaybookCard[] = of('card').map((i) => ({ id: i.key, ...i.content, lastReviewed: day(i.reviewedAt) }));
  const checks: RegulatoryCheck[] = of('check').map((i) => ({ key: i.key, ...i.content, lastReviewed: day(i.reviewedAt) }));

  if (cards.length === 0) errors.push('A release needs at least one approved playbook card.');
  for (const s of REGULATED_STAGES) {
    if (!checks.some((c) => c.appliesToStages.includes(s))) errors.push(`No approved regulatory check covers “${STAGES[s].name}”.`);
  }
  const cite = (owner: string, refs: SourceRef[] | undefined) => (refs ?? []).forEach((r) => {
    if (!sourceKeys.has(r.sourceKey)) errors.push(`${owner} cites source “${r.sourceKey}”, which has no approved version.`);
  });
  cards.forEach((c) => cite(`Card “${c.title}”`, c.sourceRefs));
  checks.forEach((c) => cite(`Check “${c.title}”`, c.sourceRefs));

  return { playbook: { version, cards, checks, sources, reviewed: true }, errors };
}

// What changed since the last approved version — shown to the reviewer. Lists report additions
// and removals item by item, so a reviewer never has to spot the difference by eye.
export interface FieldChange { field: string; before: string; after: string; added?: string[]; removed?: string[] }
export function diffContent(before: Record<string, unknown> | null, after: Record<string, unknown>): FieldChange[] {
  const item = (x: unknown) => (typeof x === 'object' && x !== null ? Object.values(x).filter(Boolean).join(' | ') : String(x));
  const show = (v: unknown) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map(item).join('\n') : String(v));
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
    .filter((k) => JSON.stringify((before ?? {})[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => {
      const b = (before ?? {})[k], a = after[k];
      const change: FieldChange = { field: k, before: show(b), after: show(a) };
      if (Array.isArray(a) || Array.isArray(b)) {
        const bs = (Array.isArray(b) ? b : []).map(item), as = (Array.isArray(a) ? a : []).map(item);
        change.added = as.filter((x) => !bs.includes(x));
        change.removed = bs.filter((x) => !as.includes(x));
      }
      return change;
    });
}

export function formatCitation(ref: SourceRef, sources: SourceSnapshot[] | undefined): string | null {
  const s = sources?.find((x) => x.key === ref.sourceKey);
  if (!s) return null;
  return `${s.title}${ref.section ? `, ${ref.section}` : ''} (${s.publisher}, updated ${s.updatedOn}) — ${s.reference}`;
}

// The checks that apply to a pain point, with their citations. If none apply at a regulated stage,
// the caller must say the approved knowledge base does not cover it (brief §9.1).
export function checksFor(pb: Playbook, stageId: StageId, classification: string | null): { check: RegulatoryCheck; citations: string[] }[] {
  return (pb.checks ?? [])
    .filter((c) => c.appliesToStages.includes(stageId) && (c.appliesTo === 'any_change' || classification === 'automate'))
    .map((check) => ({ check, citations: check.sourceRefs.map((r) => formatCitation(r, pb.sources)).filter((x): x is string => !!x) }));
}

export const nextReleaseVersion = (existing: string[], now = new Date()): string => {
  const prefix = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const n = existing.filter((v) => v.startsWith(`${prefix}.`)).map((v) => Number(v.split('.')[2])).filter(Number.isFinite);
  return `${prefix}.${(n.length ? Math.max(...n) : 0) + 1}`;
};
