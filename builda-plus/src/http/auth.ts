import type { FastifyRequest } from 'fastify';
import { signParticipant, verifyParticipant } from './tokens';

// Firm-lead authentication is pluggable so builda+ can use Builda's existing auth.
// Implement FirmLeadAuth against Builda's session/JWT and pass it to buildApp().
export interface FirmLeadIdentity { userId: string; orgId: string }
export interface FirmLeadAuth { authenticate(req: FastifyRequest): Promise<FirmLeadIdentity | null> }

// JADA staff identity — likewise pluggable (e.g. JADA's own SSO).
export interface JadaAuth { authenticateJada(req: FastifyRequest): Promise<{ userId: string } | null> }

// Development only: identity from a signed cookie set by /dev/login. Refuses to run in production.
export class DevCookieAuth implements FirmLeadAuth, JadaAuth {
  constructor(private secret: string) {
    if (process.env.NODE_ENV === 'production') throw new Error('DevCookieAuth must not be used in production');
  }
  cookieFor(identity: FirmLeadIdentity): string {
    return signParticipant({ participantId: identity.userId, orgId: identity.orgId, discoveryId: 'dev' }, this.secret, 60 * 60 * 8);
  }
  jadaCookieFor(userId: string): string {
    return signParticipant({ participantId: userId, orgId: '', discoveryId: 'dev-jada' }, this.secret, 60 * 60 * 8);
  }
  async authenticateJada(req: FastifyRequest): Promise<{ userId: string } | null> {
    const p = verifyParticipant(req.cookies['bp_jada'], this.secret);
    return p && p.discoveryId === 'dev-jada' ? { userId: p.participantId } : null;
  }
  async authenticate(req: FastifyRequest): Promise<FirmLeadIdentity | null> {
    const p = verifyParticipant(req.cookies['bp_dev'], this.secret);
    return p && p.discoveryId === 'dev' ? { userId: p.participantId, orgId: p.orgId } : null;
  }
}
