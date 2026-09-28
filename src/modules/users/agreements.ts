import { AGREEMENT_TYPES, type Agreement, type AgreementType, type User } from './user.model.js';

/**
 * The current version of each legal document. The documents are placeholders until the client's
 * legal adviser supplies them (plan §16, item 11); publishing a new version means changing its date
 * here, and users accept it again (plan §6.1).
 */
export const AGREEMENT_VERSIONS: Record<AgreementType, string> = {
  TERMS: '2026-09-28',
  PRIVACY: '2026-09-28',
  GUEST: '2026-09-28',
  HOST: '2026-09-28',
};

/** Acceptance records for the current version of each document, with when and from where (plan §14). */
export function acceptAgreements(types: AgreementType[], ip?: string, at = new Date()): Agreement[] {
  return types.map((type) => ({ type, version: AGREEMENT_VERSIONS[type], acceptedAt: at, ip }));
}

/**
 * The documents the user has to accept (again) before carrying on, because a new version was published
 * since they last did (plan §6.1: at their next sign-in). Guests and Hosts always need the current Terms
 * and Privacy Policy; the Guest and Host Agreements only once they've accepted one before, since checkout
 * and the Host application ask for those. Staff-only accounts aren't asked.
 */
export function pendingAgreements(user: Pick<User, 'roles' | 'agreements'>): AgreementType[] {
  if (!user.roles.includes('GUEST') && !user.roles.includes('HOST')) return [];
  const everAccepted = (type: AgreementType) => user.agreements.some((agreement) => agreement.type === type);
  const acceptedCurrent = (type: AgreementType) =>
    user.agreements.some(
      (agreement) => agreement.type === type && agreement.version === AGREEMENT_VERSIONS[type],
    );

  return AGREEMENT_TYPES.filter(
    (type) => (type === 'TERMS' || type === 'PRIVACY' || everAccepted(type)) && !acceptedCurrent(type),
  );
}
