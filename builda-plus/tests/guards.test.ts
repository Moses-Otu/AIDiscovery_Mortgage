import { describe, expect, it } from 'vitest';
import { scanForClientData } from '../src/guards/clientData';
import { keywordEscalation } from '../src/guards/escalation';

describe('client data guard', () => {
  it.each([
    ['NI number', 'his NI is QQ 12 34 56 C'],
    ['email', 'I emailed jane.doe@example.com'],
    ['mobile', 'call her on 07700 900123'],
    ['titled name', 'Mrs Patel was waiting on payslips'],
    ['sort code', 'sort code 12-34-56'],
  ])('blocks %s', (_l, text) => {
    const s = scanForClientData(text);
    expect(s.definite).toBe(true);
    expect(s.redacted).toContain('[REDACTED:');
  });
  it('treats postcodes as possible, not definite', () => {
    const s = scanForClientData('the property in SW1A 1AA');
    expect(s.definite).toBe(false);
    expect(s.possible).toBe(true);
  });
  it('lets ordinary process talk through', () => {
    const s = scanForClientData('We do about 150 applications a month and chasing takes 20 minutes each, usually 3 times.');
    expect(s.findings).toEqual([]);
  });
});

describe('keyword escalation', () => {
  it('escalates clear employment issues', () => expect(keywordEscalation('I have raised a grievance about my manager')).toBe('employment_issue'));
  it('does not escalate process talk about complaints', () => expect(keywordEscalation('complaint handling takes ages')).toBeNull());
});
