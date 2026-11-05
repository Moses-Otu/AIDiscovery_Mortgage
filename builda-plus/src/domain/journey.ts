// Mortgage journey (brief §5.1). Order of STAGE_IDS is the journey order.
export const STAGE_IDS = [
  'enquiry', 'disclosure_id', 'fact_find', 'documents', 'research_affordability',
  'dip', 'recommendation', 'protection', 'full_application', 'valuation_underwriting',
  'offer', 'legal_exchange', 'completion', 'aftercare_renewal',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface Stage { id: StageId; name: string; regulatedJudgement: boolean; note?: string }

export const STAGES: Record<StageId, Stage> = {
  enquiry: { id: 'enquiry', name: 'Enquiry', regulatedJudgement: false },
  disclosure_id: { id: 'disclosure_id', name: 'Initial disclosure and identity checks', regulatedJudgement: false },
  fact_find: { id: 'fact_find', name: 'Fact find', regulatedJudgement: true },
  documents: { id: 'documents', name: 'Documents', regulatedJudgement: false },
  research_affordability: { id: 'research_affordability', name: 'Research and affordability', regulatedJudgement: true },
  dip: { id: 'dip', name: 'Decision in principle', regulatedJudgement: false },
  recommendation: { id: 'recommendation', name: 'Recommendation and suitability letter', regulatedJudgement: true },
  protection: { id: 'protection', name: 'Protection advice', regulatedJudgement: true, note: 'Separate advised sale, usually alongside recommendation' },
  full_application: { id: 'full_application', name: 'Full application', regulatedJudgement: false },
  valuation_underwriting: { id: 'valuation_underwriting', name: 'Valuation and underwriting', regulatedJudgement: false },
  offer: { id: 'offer', name: 'Mortgage offer', regulatedJudgement: false },
  legal_exchange: { id: 'legal_exchange', name: 'Legal work to exchange', regulatedJudgement: false },
  completion: { id: 'completion', name: 'Completion', regulatedJudgement: false },
  aftercare_renewal: { id: 'aftercare_renewal', name: 'Aftercare and renewal', regulatedJudgement: false },
};

export const ROLES = ['firm_lead', 'adviser', 'case_manager', 'administrator', 'other'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  firm_lead: 'Firm owner / Managing Director',
  adviser: 'Mortgage adviser',
  case_manager: 'Case manager',
  administrator: 'Administrator',
  other: 'Operational staff',
};

// Starting scope only: the interview confirms or narrows it (participants are only
// questioned about processes they understand, brief §4 step 4).
export const DEFAULT_STAGES_BY_ROLE: Record<Role, StageId[]> = {
  firm_lead: [...STAGE_IDS],
  adviser: ['enquiry', 'fact_find', 'research_affordability', 'dip', 'recommendation', 'protection', 'full_application', 'aftercare_renewal'],
  case_manager: ['disclosure_id', 'documents', 'dip', 'full_application', 'valuation_underwriting', 'offer', 'legal_exchange', 'completion'],
  administrator: ['enquiry', 'disclosure_id', 'documents', 'full_application', 'offer', 'completion', 'aftercare_renewal'],
  other: [...STAGE_IDS],
};

export const CLASSIFICATIONS = ['overhaul', 'fix', 'automate', 'keep_human'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
