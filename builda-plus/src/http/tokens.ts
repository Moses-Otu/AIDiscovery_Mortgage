import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const newInvitationToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// Participant session: signed, expiring, carries no personal information.
export interface ParticipantPrincipal { participantId: string; orgId: string; discoveryId: string }

export function signParticipant(p: ParticipantPrincipal, secret: string, ttlSeconds = 60 * 60 * 24 * 14): string {
  const payload = Buffer.from(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyParticipant(token: string | undefined, secret: string): ParticipantPrincipal | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return { participantId: data.participantId, orgId: data.orgId, discoveryId: data.discoveryId };
  } catch { return null; }
}
