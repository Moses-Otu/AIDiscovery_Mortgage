import { z } from 'zod';
import { ROLES } from '../domain/journey';

// Firm profile questionnaire (brief §4 step 2). Completed by the firm lead before interviews.
export const FirmProfileSchema = z.object({
  advisers: z.number().int().min(0).max(500),
  monthlyApplications: z.number().int().min(0).nullable(),
  typicalWeeksEnquiryToOffer: z.number().min(0).max(104).nullable(),
  businessStructure: z.string().max(1000),
  staffRoles: z.array(z.object({ role: z.enum(ROLES), count: z.number().int().min(0) })),
  systems: z.array(z.string().max(100)).max(50),
  authorisation: z.enum(['directly_authorised', 'network_appointed_representative', 'unsure']),
  operationalChallenges: z.string().max(4000),
  // Optional: used only to put a value on recovered capacity. Never estimated by the platform.
  loadedHourlyCostGBP: z.number().positive().max(1000).nullable(),
});
export type FirmProfile = z.infer<typeof FirmProfileSchema>;
