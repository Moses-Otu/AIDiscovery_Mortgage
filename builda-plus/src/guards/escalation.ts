import type { TurnInterpretation } from '../domain/schemas';

// Human escalation (brief §11).
export type EscalationReason =
  | 'client_information' | 'complaint_or_compliance' | 'employment_issue'
  | 'advice_request' | 'out_of_scope' | 'firm_lead_requested' | 'insufficient_evidence';

// Only unambiguous employment/whistleblowing terms escalate on keywords alone.
// Words like "complaint" are often process talk ("complaint handling is slow"), so those
// rely on the model's flag rather than a keyword.
const HARD_KEYWORDS = /\b(grievance|tribunal|bullying|bullied|harass\w*|discriminat\w*|unfair(ly)? dismiss\w*|whistle-?blow\w*)\b/i;

export function keywordEscalation(text: string): EscalationReason | null {
  return HARD_KEYWORDS.test(text) ? 'employment_issue' : null;
}

export function flagEscalation(flags: TurnInterpretation['flags']): EscalationReason | null {
  if (flags.clientInformation) return 'client_information';
  if (flags.complaintOrCompliance) return 'complaint_or_compliance';
  if (flags.employmentIssue) return 'employment_issue';
  if (flags.adviceRequest) return 'advice_request';
  if (flags.outOfScope) return 'out_of_scope';
  return null;
}

export const ESCALATION_MESSAGES: Record<EscalationReason, string> = {
  client_information: "Thanks — I need to pause here because your message looked like it contained client details. This discovery can't hold client information, so I've removed it and passed this to a JADA contact, who will be in touch about how to continue.",
  complaint_or_compliance: "Thank you for raising that. It's something a person should handle rather than me, so I've paused the interview and passed it to a JADA contact, who will follow up with you.",
  employment_issue: "Thank you for telling me. That's important and needs a person rather than this interview, so I've paused here and passed it to a JADA contact, who will follow up with you directly.",
  advice_request: "I'm not able to give mortgage advice or comment on a real client case. I've paused the interview and flagged it to a JADA contact in case you'd like to talk it through with someone.",
  out_of_scope: "That's outside what this discovery covers, so I've paused and passed it to a JADA contact who can help.",
  firm_lead_requested: 'A JADA contact has been asked to get in touch.',
  insufficient_evidence: 'A JADA contact will review this discovery with you.',
};
