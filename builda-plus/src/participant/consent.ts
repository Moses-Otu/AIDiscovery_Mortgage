// Participant information and consent (brief §4 step 3, §10). Versioned: changing the text
// means a new version, and each participant's consent records the version they agreed to.
export const CONSENT_VERSION = 'consent-2026-11-v1';

export interface ConsentConfig { retentionMonths: number | null; jadaContact: string | null; firmName: string }

export function consentSections(cfg: ConsentConfig): { heading: string; body: string }[] {
  const retention = cfg.retentionMonths
    ? `Your interview is kept for ${cfg.retentionMonths} months after the discovery finishes and then deleted.`
    : 'Retention period: to be confirmed before launch.';
  return [
    { heading: 'What this is for', body: `${cfg.firmName} is reviewing how work moves through the business, so it can find what slows things down and what could be improved or automated. This is about processes, not about assessing you or your performance.` },
    { heading: 'How long it takes', body: 'About 20 to 30 minutes. You can pause at any point and pick up where you left off using the same link.' },
    { heading: 'What you’ll be asked', body: 'An AI interviewer asks about the parts of the mortgage process you work on: the tasks involved, roughly how often they happen and how long they take, the systems you use, and what gets in the way. You only get questions about work you do.' },
    { heading: 'What not to share', body: 'Please do not include client names, contact details, case details or client documents. If something like that is typed, the interview pauses, the details are removed and a person from JADA will get in touch.' },
    { heading: 'Who sees your answers', body: `Your firm lead sees findings grouped by role (for example, “case manager”), not by your name. Your name is never sent to the AI. JADA staff working on this discovery can see the interview to prepare recommendations.` },
    { heading: 'Raising concerns', body: `If you raise a complaint, a compliance concern or a personal employment matter, the interview pauses and a person handles it instead. ${cfg.jadaContact ? `Your JADA contact is ${cfg.jadaContact}.` : 'JADA contact: to be confirmed before launch.'}` },
    { heading: 'Keeping your information', body: retention },
  ];
}

export function assertConsentConfigReady(cfg: ConsentConfig): void {
  if (process.env.NODE_ENV === 'production' && (!cfg.retentionMonths || !cfg.jadaContact)) {
    throw new Error('Retention period and JADA contact must be configured before running in production');
  }
}
