// JADA automation template library (brief §7). Owned by JADA engineering.
export interface AutomationTemplate {
  id: string;
  name: string;
  painPointKeys: string[];
  tested: boolean;                 // only tested templates can qualify for the two-week build
  expectedReductionPct: number;    // share of active time removed — a planning assumption until measured
  reductionBasis: string;
  typicalComplexity: 'low' | 'medium' | 'high';
  humanApprovalBuiltIn: boolean;
  owner: string;
  spec: {
    workflow: string;
    targetProcess: string[];
    accessRequirements: string[];
    automationRequirements: string[];
    humanApprovalPoints: string[];
    keepWithPeople: string[];
    testCases: { name: string; given: string; when: string; then: string }[];
    definitionOfDone: string[];
    standardRisks: string[];
    outOfScope: string[];
  };
}

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: 'document_chasing_v1',
    name: 'Document chasing with staff-approved reminders',
    painPointKeys: ['document_chasing'],
    tested: false,
    expectedReductionPct: 0.5,
    reductionBasis: 'Planning assumption pending the first implementations — not yet measured',
    typicalComplexity: 'low',
    humanApprovalBuiltIn: true,
    owner: 'JADA engineering',
    spec: {
      workflow: 'From a case being marked as waiting for documents, to every required document received or the case handed back to a person.',
      targetProcess: [
        'Case manager records the outstanding documents for a case in the firm’s system.',
        'The automation drafts a reminder from a firm-approved template, listing only the outstanding items.',
        'Staff approve each reminder, or approve a batch, before anything is sent.',
        'Approved reminders go out on the firm’s chosen schedule.',
        'When staff mark a document as received, it drops out of future reminders.',
        'If the client replies, the sequence pauses and the case manager is notified.',
        'After the final reminder, the case is flagged to the case manager for a call.',
        'A weekly list shows cases that have stalled.',
      ],
      accessRequirements: [
        'Read access to case status and the outstanding-documents list (API, or an agreed export).',
        'A sending mailbox or domain the firm approves for client email.',
        'Test cases with dummy data — no real client data during the build.',
        'A named person at the firm who approves reminder templates.',
      ],
      automationRequirements: [
        'Every reminder is logged with what was sent, when and who approved it.',
        'Client details stay in the firm’s systems; the automation keeps only a case reference.',
        'Templates are versioned; changing one requires re-approval.',
        'A single switch turns the automation off.',
      ],
      humanApprovalPoints: [
        'Reminder templates approved by the firm before go-live.',
        'Each reminder or batch approved by staff before sending.',
        'No changes to case records without a person confirming them.',
      ],
      keepWithPeople: [
        'Judging whether a document is acceptable.',
        'Conversations with clients who are struggling to provide documents.',
        'Anything that involves advice or suitability.',
      ],
      testCases: [
        { name: 'Draft, not send', given: 'A test case with two outstanding documents', when: 'The schedule triggers', then: 'A reminder listing both is drafted and waits for approval; nothing is sent' },
        { name: 'Received documents drop out', given: 'One of the two documents is marked received', when: 'The next reminder is drafted', then: 'It lists only the remaining document' },
        { name: 'Reply pauses the sequence', given: 'The client replies to a reminder', when: 'The reply arrives', then: 'Further reminders pause and the case manager is notified' },
        { name: 'Hand back after final reminder', given: 'The final reminder has had no response', when: 'The waiting period ends', then: 'The case is flagged to the case manager and no more reminders are drafted' },
        { name: 'Rejected draft', given: 'An approver rejects a draft', when: 'They reject it', then: 'Nothing is sent and the rejection is logged' },
        { name: 'No client data in logs', given: 'Any run of the automation', when: 'Logs are inspected', then: 'They contain case references only — no names, addresses or document contents' },
      ],
      definitionOfDone: [
        'All test cases pass on the firm’s test data.',
        'The firm’s named approver has signed off the templates.',
        'One week live on a pilot group of cases with no unapproved sends.',
        'Chasing time per application measured before go-live, for the before/after comparison.',
        'Switch-off tested and a handover note given to the firm.',
      ],
      standardRisks: [
        'The firm’s system may have no API — fall back to an agreed export, which can add delay.',
        'Email deliverability from a new sending address.',
        'If the outstanding-documents list is wrong, reminders will be wrong — mitigated by staff approval.',
      ],
      outOfScope: ['Reading or checking document contents', 'Changes to the firm’s core systems', 'Automated messages without staff approval'],
    },
  },
];

export const templateFor = (key: string, list = TEMPLATES) => list.find((t) => t.painPointKeys.includes(key)) ?? null;
