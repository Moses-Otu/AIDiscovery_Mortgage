import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReportModel } from '../src/report/model';
import { renderReportPdf } from '../src/report/pdf';
import { buildImplementationPack, assessReview, packToMarkdown, PackNotPossibleError } from '../src/implementation/pack';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';
import { TEMPLATES } from '../src/knowledge/templates';
import type { Playbook } from '../src/knowledge/playbook';

const reviewedKb: Playbook = {
  version: '2026.11.1', reviewed: true, cards: SEED_PLAYBOOK.cards,
  sources: [{ key: 'fca-mcob', title: 'FCA Handbook: MCOB', reference: 'https://www.handbook.fca.org.uk/handbook/MCOB', publisher: 'FCA', updatedOn: '2025-06-01', sections: [], summary: '', owner: 'Compliance lead', lastReviewed: '2026-11-04' }],
  checks: [{ key: 'reminders_consumer_duty', title: 'Client communications are clear and fair', statement: 'Automated client messages must be clear, fair and not misleading.',
    appliesToStages: ['documents'], appliesTo: 'automation', requiredAction: 'Compliance approves message templates before go-live', owner: 'Compliance lead', lastReviewed: '2026-11-04',
    sourceRefs: [{ sourceKey: 'fca-mcob', section: 'Consumer Duty, PRIN 2A' }] }],
};

const pp = (over: Record<string, unknown>) => ({
  id: 'pp1', key: 'document_chasing', title: 'Manual chasing of outstanding client documents', stageId: 'documents', stageName: 'Documents',
  classification: 'automate', classificationSource: 'ai_proposed', classificationRationale: 'Repetitive.', requiresComplianceReview: false, validated: false,
  confidence: 'low', confidenceReasons: [], roles: ['Case manager', 'Mortgage adviser'], participantCount: 2,
  volume: { value: 150, min: 150, max: 150, n: 2 }, minutes: { value: 25, min: 10, max: 40, n: 2 }, overrides: {},
  disagreements: [{ field: 'minutesPerOccurrence', values: [{ role: 'Case manager', value: 10 }, { role: 'Mortgage adviser', value: 40 }] }],
  quotes: [{ role: 'Case manager', quote: 'we chase about 150 a month — £-heavy work' }], systems: ['CRM', 'Email'],
  causes: ['Clients send documents in pieces'], improvements: ['Automatic reminders'], outstandingQuestions: ['Which CRM fields hold outstanding documents?'],
  missingMeasurements: [], impact: { monthlyHoursSpent: 62.5, monthlyHoursRecovered: 31.3, monthlyCapacityValueGBP: 688, paybackMonths: null, unknowns: ['Implementation cost'], caveats: [] },
  score: 70, rank: 1, twoWeek: { status: 'blocked', blockers: ['Template "Document chasing with staff-approved reminders" is not yet tested'], toConfirmInEngineeringReview: ['Access and test data ready on day one'] },
  assumptions: ['Reduction of 50%: Planning assumption'], explanation: [], corrections: [], ...over,
});
const playback: any = {
  analysedAt: new Date(), scoringConfigVersion: 'v1',
  participation: [{ role: 'Case manager', status: 'completed' }, { role: 'Mortgage adviser', status: 'completed' }, { role: 'Administrator', status: 'invited' }],
  journey: [{ id: 'documents', name: 'Documents', regulatedJudgement: false, painPoints: ['pp1'] }, { id: 'recommendation', name: 'Recommendation and suitability letter', regulatedJudgement: true, painPoints: ['pp2'] }],
  painPoints: [pp({}), pp({ id: 'pp2', key: 'suitability_admin', title: 'Assembling suitability letter packs', stageId: 'recommendation', stageName: 'Recommendation and suitability letter',
    classification: 'fix', requiresComplianceReview: true, rank: 2, disagreements: [], impact: { monthlyHoursSpent: 20, monthlyHoursRecovered: null, monthlyCapacityValueGBP: null, unknowns: ['Proportion of work that can be reduced'] } })],
  topThree: ['pp1', 'pp2'],
  crossRole: { agreements: [], disagreements: ['document_chasing'], blindSpots: [], firmLeadInterviewed: false, unreportedStages: ['Completion'], missingMeasurements: [] },
};

describe('discovery report', () => {
  const model = buildReportModel({ playback, profile: null, firmName: 'Harbour Lane Mortgages', discoveryId: 'd1', version: 1, now: new Date('2026-11-05T10:00:00Z') });

  it('builds business cases that keep unknowns unknown', () => {
    expect(model.businessCases).toHaveLength(2);
    expect(model.businessCases[0]!.figures.find((f) => f.label.startsWith('Value'))!.value).toBe('£688');
    expect(model.businessCases[1]!.figures.find((f) => f.label.startsWith('Hours that'))!.value).toBe('Unknown');
    expect(model.businessCases[0]!.payback).toMatch(/not yet known/);
  });
  it('flags regulated items, the firm-lead gap and what is still needed', () => {
    expect(model.regulatoryReview[0]).toMatch(/Assembling suitability letter packs.*compliance professional/);
    expect(model.crossRole.blindSpots).toBeNull();
    expect(model.recommendedBuild).toMatchObject({ status: 'blocked', title: 'Manual chasing of outstanding client documents' });
    expect(model.toProceed.some((t) => /hourly staff cost/.test(t))).toBe(true);
  });
  it('renders a readable PDF with the key content and correct characters', async () => {
    const pdf = await renderReportPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const dir = mkdtempSync(join(tmpdir(), 'rep-'));
    writeFileSync(join(dir, 'r.pdf'), pdf);
    const text = execFileSync('pdftotext', [join(dir, 'r.pdf'), '-']).toString().replace(/\s+/g, ' ');
    for (const s of ['Harbour Lane Mortgages', 'Top opportunities', '£688', 'Case manager 10; Mortgage adviser 40', 'Points for compliance review', 'not approved by the FCA', 'Page 1 of'])
      expect(text).toContain(s);
    expect(text).toContain('“we chase about 150 a month — £-heavy work”');
  });
});

describe('knowledge in outputs', () => {
  it('report cites approved checks and states gaps at regulated stages', async () => {
    const m = buildReportModel({ playback, profile: null, firmName: 'Harbour Lane Mortgages', discoveryId: 'd1', version: 1, playbook: reviewedKb });
    const chasing = m.regulatoryItems.find((r) => r.title.startsWith('Manual chasing'))!;
    expect(chasing.checks[0]!.citations[0]).toMatch(/FCA Handbook: MCOB, Consumer Duty, PRIN 2A/);
    const letters = m.regulatoryItems.find((r) => r.title.startsWith('Assembling'))!;
    expect(letters).toMatchObject({ notCovered: true, checks: [] });
    expect(m.disclaimers[0]).toMatch(/knowledge release 2026.11.1, approved/);
    const pdf = await renderReportPdf(m, { compress: false });
    const dir = mkdtempSync(join(tmpdir(), 'rep-')); writeFileSync(join(dir, 'r.pdf'), pdf);
    const text = execFileSync('pdftotext', [join(dir, 'r.pdf'), '-']).toString().replace(/\s+/g, ' ');
    expect(text).toContain('Not covered by the approved knowledge base');
    expect(text).toContain('Source: FCA Handbook: MCOB');
    expect(text).not.toContain('unreviewed development playbook');
  });
  it('outputs from the unreviewed seed carry a warning', () => {
    const m = buildReportModel({ playback, profile: null, firmName: 'X', discoveryId: 'd1', version: 1, playbook: SEED_PLAYBOOK });
    expect(m.disclaimers[0]).toMatch(/^WARNING: produced with an unreviewed development playbook/);
    const pack = buildImplementationPack({ playback, painPointId: 'pp1', profile: null, playbook: SEED_PLAYBOOK });
    expect(pack.openQuestions).toContain('This pack was built from the unreviewed development playbook — re-check against an approved release.');
  });
  it('pack carries the applicable checks with citations', () => {
    const pack = buildImplementationPack({ playback, painPointId: 'pp1', profile: null, playbook: reviewedKb });
    expect(pack.knowledge).toEqual({ version: '2026.11.1', reviewed: true });
    expect(pack.regulatoryChecks[0]).toMatchObject({ title: 'Client communications are clear and fair', requiredAction: 'Compliance approves message templates before go-live' });
    expect(packToMarkdown(pack, 'X')).toMatch(/## Regulatory checks \(knowledge release 2026.11.1\)\n- \*\*Client communications/);
  });
});

describe('implementation pack', () => {
  it('is assembled from the template, playbook and evidence', () => {
    const pack = buildImplementationPack({ playback, painPointId: 'pp1', profile: null, playbook: SEED_PLAYBOOK, now: new Date(0) });
    expect(pack.template).toEqual({ id: 'document_chasing_v1', name: 'Document chasing with staff-approved reminders', tested: false });
    expect(pack.testCases.length).toBeGreaterThanOrEqual(6);
    expect(pack.humanApprovalPoints).toContain('Each reminder or batch approved by staff before sending.');   // template wins over the generic card
    expect(pack.currentProcess.facts.some((f) => /Case manager 10; Mortgage adviser 40/.test(f))).toBe(true);
    expect(pack.openQuestions).toContain('Which CRM fields hold outstanding documents?');
    expect(pack.firmRules[0]).toMatch(/confirm authorisation status/);
    expect(pack.dependencies).toEqual(['Access to CRM', 'Access to Email']);
    const md = packToMarkdown(pack, 'Harbour Lane Mortgages');
    expect(md).toMatch(/## Test cases\n- \*\*Draft, not send\*\*/);
  });
  it('only exists for automation candidates, and says where no template covers something', () => {
    expect(() => buildImplementationPack({ playback, painPointId: 'pp2', profile: null, playbook: SEED_PLAYBOOK })).toThrow(PackNotPossibleError);
    const noTemplate = { ...playback, painPoints: [pp({ key: 'new_thing' })] };
    const pack = buildImplementationPack({ playback: noTemplate, painPointId: 'pp1', profile: null, playbook: SEED_PLAYBOOK });
    expect(pack.template).toBeNull();
    expect(pack.targetProcess[0]).toMatch(/No template covers/);
  });
  it('confirms a two-week build only when everything holds, including a tested template', () => {
    const allGood = { checks: { singleWorkflowWithStartAndFinish: true, changesCoreSystems: false, accessAndTestDataReadyDayOne: true, humanApprovalForCommsAndRecordChanges: true, complianceQuestionsResolved: true }, unresolvedDependencies: [], notes: '' };
    const untested = buildImplementationPack({ playback, painPointId: 'pp1', profile: null, playbook: SEED_PLAYBOOK });
    expect(assessReview(untested, allGood).failures).toEqual(['Template document_chasing_v1 is not yet tested']);
    const tested = buildImplementationPack({ playback, painPointId: 'pp1', profile: null, playbook: SEED_PLAYBOOK, templates: TEMPLATES.map((t) => ({ ...t, tested: true })) });
    expect(assessReview(tested, allGood)).toEqual({ qualifies: true, failures: [] });
    expect(assessReview(tested, { ...allGood, unresolvedDependencies: ['CRM API key'] }).qualifies).toBe(false);
  });
});
