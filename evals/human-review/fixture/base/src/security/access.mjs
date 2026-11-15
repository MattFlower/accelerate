import { timingSafeEqual, createHmac } from 'node:crypto';

/** Internal callers use scoped, expiring capabilities. */
export function signCapability(claims, secret) {
  if (!secret) throw new Error('signing secret is required');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readCapability(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [payload, supplied] = parts;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= now) return undefined;
    if (!Array.isArray(claims.scopes)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

export function permits(claims, scope) {
  return Boolean(claims?.scopes.includes(scope));
}

/** Require every requested scope; an absent identity never authorizes work. */
export function authorize(claims, required, { subject, audience } = {}) {
  if (!claims || !Array.isArray(claims.scopes)) return false;
  if (!Array.isArray(required) || required.some(scope => !claims.scopes.includes(scope))) return false;
  if (subject !== undefined && claims.subject !== subject) return false;
  if (audience !== undefined && claims.audience !== audience) return false;
  return true;
}

export function issueCapability({ subject, scopes, audience, ttlMs = 60000 }, secret, now = Date.now()) {
  if (typeof subject !== 'string' || !subject) throw new Error('subject is required');
  if (!Array.isArray(scopes) || !scopes.length ||
      scopes.some(scope => typeof scope !== 'string' || !scope)) throw new Error('invalid scopes');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('invalid lifetime');
  return signCapability({ subject, scopes: [...new Set(scopes)], audience,
    issuedAt: now, expiresAt: now + ttlMs }, secret);
}

/** Rotation accepts old verification secrets while issuing only with the active one. */
export class CapabilityIssuer {
  constructor(active, previous = []) {
    if (!active || previous.some(secret => !secret)) throw new Error('invalid secrets');
    this.active = active;
    this.verificationSecrets = [active, ...previous];
    this.revoked = new Set();
  }

  issue(options, now) {
    return issueCapability(options, this.active, now);
  }

  read(token, now) {
    for (const secret of this.verificationSecrets) {
      const claims = readCapability(token, secret, now);
      if (claims && !this.revoked.has(claims.subject)) return claims;
    }
    return undefined;
  }

  revokeSubject(subject) {
    if (typeof subject !== 'string' || !subject) throw new Error('subject is required');
    this.revoked.add(subject);
  }

  restoreSubject(subject) {
    return this.revoked.delete(subject);
  }
}
