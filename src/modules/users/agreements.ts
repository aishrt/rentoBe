import type { Agreement, AgreementType } from './user.model.js';

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
