import type { Classification } from '../domain/journey';

// Two-week implementation qualification (brief §7). Every condition must hold.
export interface FeasibilityInput {
  classification: Classification;
  singleWorkflowWithStartAndFinish: boolean;
  templateId: string | null;
  templateTested: boolean;
  changesCoreSystems: boolean;
  accessAndTestDataReadyDayOne: boolean;
  humanApprovalForCommsAndRecordChanges: boolean;
  complianceQuestionsResolved: boolean;
  unresolvedDependencies: string[];
}
export interface FeasibilityResult { qualifies: boolean; failures: string[] }

export function assessTwoWeekFeasibility(i: FeasibilityInput): FeasibilityResult {
  const f: string[] = [];
  if (i.classification !== 'automate') f.push(`Classified "${i.classification}", not "automate"`);
  if (!i.singleWorkflowWithStartAndFinish) f.push('Not one clearly defined workflow with a start and finish');
  if (!i.templateId) f.push('No JADA automation template');
  else if (!i.templateTested) f.push(`Template ${i.templateId} is not yet tested`);
  if (i.changesCoreSystems) f.push("Requires changes to the firm's core systems");
  if (!i.accessAndTestDataReadyDayOne) f.push('Access and test data not available on day one');
  if (!i.humanApprovalForCommsAndRecordChanges) f.push('No human approval step for communications or record changes');
  if (!i.complianceQuestionsResolved) f.push('Compliance questions unresolved');
  for (const d of i.unresolvedDependencies) f.push(`Unresolved dependency: ${d}`);
  return { qualifies: f.length === 0, failures: f };
}
