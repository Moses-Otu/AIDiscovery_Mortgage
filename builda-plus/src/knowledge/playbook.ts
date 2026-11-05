import type { Classification, Role, StageId } from '../domain/journey';

// Pain-point cards (brief §5.3). These seeds are DRAFTS: they must be reviewed by a
// named mortgage/compliance owner before use with real firms.
export interface PlaybookCard {
  id: string;
  title: string;
  stageId: StageId;
  roles: Role[];
  signs: string[];
  interviewQuestions: string[];
  infoToCollect: string[];
  metrics: string[];
  likelyClassification: Classification;
  automationPatterns: string[];
  humanApproval: string[];
  regulatoryLimits: string[];
  owner: string;
  lastReviewed: string | null;
  sourceRefs?: SourceRef[];
}

export interface SourceRef { sourceKey: string; section: string }

// UK regulatory checks (brief §9.3): approved statements, with sources, about what must happen
// before anything at a given stage changes. Enforcement stays in code; these explain and cite.
export interface RegulatoryCheck {
  key: string;
  title: string;
  statement: string;
  appliesToStages: StageId[];
  appliesTo: 'any_change' | 'automation';
  requiredAction: string;
  sourceRefs: SourceRef[];
  owner: string;
  lastReviewed: string | null;
}

export interface SourceSnapshot {
  key: string; title: string; reference: string; publisher: string; updatedOn: string;
  sections: string[]; summary: string; owner: string; lastReviewed: string | null;
}

export interface Playbook {
  version: string;
  cards: PlaybookCard[];
  checks?: RegulatoryCheck[];
  sources?: SourceSnapshot[];
  reviewed?: boolean;            // false for the development seed; true only for published releases
}

export const SEED_PLAYBOOK: Playbook = {
  version: '0.1.0-draft',
  reviewed: false,
  cards: [
    {
      id: 'document_chasing',
      title: 'Manual chasing of outstanding client documents',
      stageId: 'documents',
      roles: ['case_manager', 'administrator', 'adviser'],
      signs: ['Repeated follow-up emails or calls', 'Applications stall waiting for documents', 'Tracking kept in spreadsheets or memory'],
      interviewQuestions: [
        'Roughly how many applications are waiting on documents at any one time?',
        'How do you keep track of which documents are still outstanding?',
        'For a typical application, how many times do you need to chase, and how long does each chase take?',
      ],
      infoToCollect: ['applications per month', 'chases per application', 'minutes per chase', 'systems used to track'],
      metrics: ['Active chasing time per application'],
      likelyClassification: 'automate',
      automationPatterns: ['Scheduled reminders from a document checklist', 'Status tracker visible to the team'],
      humanApproval: ['Staff approve outbound reminder templates', 'No automated changes to case records without review'],
      regulatoryLimits: ['No automated professional judgement on document adequacy'],
      owner: 'UNASSIGNED — needs review',
      lastReviewed: null,
    },
    {
      id: 'case_status_updates',
      title: 'Manual progress updates to clients, introducers and solicitors',
      stageId: 'offer',
      roles: ['case_manager', 'administrator'],
      signs: ['Frequent "any update?" calls', 'Status checked on several lender portals'],
      interviewQuestions: [
        'How do clients and solicitors find out where an application has got to?',
        'Roughly how many status update calls or emails do you handle in a week?',
      ],
      infoToCollect: ['update requests per week', 'minutes per update', 'portals checked'],
      metrics: ['Time spent on status updates per application'],
      likelyClassification: 'automate',
      automationPatterns: ['Milestone-triggered update drafts for staff approval'],
      humanApproval: ['Staff approve each outbound update'],
      regulatoryLimits: [],
      owner: 'UNASSIGNED — needs review',
      lastReviewed: null,
    },
    {
      id: 'application_rekeying',
      title: 'Re-keying fact-find data into lender systems',
      stageId: 'full_application',
      roles: ['case_manager', 'adviser', 'administrator'],
      signs: ['Same data typed into CRM and lender portal', 'Errors spotted at underwriting'],
      interviewQuestions: [
        'When you submit a full application, how much information do you type in again that already exists elsewhere?',
        'How long does a typical submission take, start to finish?',
      ],
      infoToCollect: ['applications per month', 'minutes per submission', 'systems involved'],
      metrics: ['Submission time per application'],
      likelyClassification: 'overhaul',
      automationPatterns: ['Pre-filled submission checklist from CRM data'],
      humanApproval: ['Adviser or case manager checks every submission'],
      regulatoryLimits: ['Submission content must match the advised recommendation'],
      owner: 'UNASSIGNED — needs review',
      lastReviewed: null,
    },
  ],
};

export function cardsForStage(pb: Playbook, stageId: StageId): PlaybookCard[] {
  return pb.cards.filter((c) => c.stageId === stageId);
}
