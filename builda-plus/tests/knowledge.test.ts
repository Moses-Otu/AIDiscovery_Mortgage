import { describe, expect, it } from 'vitest';
import { assembleRelease, checksFor, diffContent, nextReleaseVersion, REGULATED_STAGES, type ApprovedItem } from '../src/knowledge/model';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';

let n = 0;
const item = (kind: ApprovedItem['kind'], key: string, content: any, version = 1): ApprovedItem => ({ id: `i${++n}`, kind, key, version, content, reviewedAt: '2026-11-04T10:00:00.000Z' });
const { id: _i, lastReviewed: _l, ...seedCard } = SEED_PLAYBOOK.cards[0]!;
const card = (v = 1, over = {}) => item('card', 'document_chasing', { ...seedCard, sourceRefs: [], ...over }, v);
const source = item('source', 'fca-mcob', { title: 'FCA Handbook: MCOB', reference: 'https://www.handbook.fca.org.uk/handbook/MCOB', publisher: 'FCA', updatedOn: '2025-06-01', sections: ['MCOB 4.7A'], summary: '', owner: 'Compliance lead' });
const check = (stages = REGULATED_STAGES, sourceKey = 'fca-mcob') => item('check', 'advice_stays_human', {
  title: 'Advice decisions stay with the adviser', statement: 'Suitability and advice decisions are made by a qualified adviser.', appliesToStages: stages,
  appliesTo: 'any_change', requiredAction: 'Compliance review before any change at this stage', owner: 'Compliance lead', sourceRefs: [{ sourceKey, section: 'MCOB 4.7A' }] });

describe('release rules', () => {
  it('refuses a release with no cards, uncovered regulated stages or unknown sources', () => {
    expect(assembleRelease('x', []).errors).toContain('A release needs at least one approved playbook card.');
    const { errors } = assembleRelease('x', [card(), check(['fact_find'], 'missing-source')]);
    expect(errors).toEqual(expect.arrayContaining([
      'No approved regulatory check covers “Recommendation and suitability letter”.',
      'Check “Advice decisions stay with the adviser” cites source “missing-source”, which has no approved version.',
    ]));
    expect(errors.some((e) => e.includes('Fact find'))).toBe(false);
  });
  it('assembles the latest approved version of each item', () => {
    const { playbook, errors } = assembleRelease('2026.11.1', [card(1), card(2, { title: 'Chasing documents (v2)' }), source, check()]);
    expect(errors).toEqual([]);
    expect(playbook.cards.map((c) => c.title)).toEqual(['Chasing documents (v2)']);
    expect(playbook.cards[0]!.lastReviewed).toBe('2026-11-04');
    expect(playbook.reviewed).toBe(true);
  });
  it('finds applicable checks with citations', () => {
    const { playbook } = assembleRelease('r', [card(), source, check(), item('check', 'auto_only', { ...check().content, title: 'Automation only rule', appliesTo: 'automation', appliesToStages: ['documents'] })]);
    expect(checksFor(playbook, 'recommendation', 'fix')[0]!.citations).toEqual(['FCA Handbook: MCOB, MCOB 4.7A (FCA, updated 2025-06-01) — https://www.handbook.fca.org.uk/handbook/MCOB']);
    expect(checksFor(playbook, 'documents', 'fix')).toEqual([]);
    expect(checksFor(playbook, 'documents', 'automate').map((c) => c.check.title)).toEqual(['Automation only rule']);
  });
  it('shows reviewers exactly what changed, item by item for lists', () => {
    expect(diffContent({ title: 'A', signs: ['x'] }, { title: 'B', signs: ['x'], owner: 'Sam' })).toEqual([
      { field: 'title', before: 'A', after: 'B' }, { field: 'owner', before: '', after: 'Sam' }]);
    expect(diffContent({ signs: ['x', 'y'] }, { signs: ['x', 'z'] })[0]).toMatchObject({ added: ['z'], removed: ['y'] });
  });
  it('numbers releases by month', () => {
    expect(nextReleaseVersion(['2026.11.1', '2026.10.4'], new Date('2026-11-20'))).toBe('2026.11.2');
    expect(nextReleaseVersion([], new Date('2027-01-02'))).toBe('2027.01.1');
  });
});
