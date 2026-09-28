import type { LegalContent } from '../../src/modules/cms/cms-block.model.js';
import { AGREEMENT_VERSIONS } from '../../src/modules/users/agreements.js';

/**
 * Placeholder legal pages (plan §9, Days 3–5), so agreement acceptance and the legal page links work from
 * the start. The client's legal adviser supplies the real text (plan §16, item 11); it's published as a
 * new version, which users accept again.
 */
export const LEGAL_PAGES: { key: string; version: string; content: LegalContent }[] = [
  { key: 'legal.terms', version: AGREEMENT_VERSIONS.TERMS, title: 'Terms & Conditions' },
  { key: 'legal.privacy', version: AGREEMENT_VERSIONS.PRIVACY, title: 'Privacy Policy' },
  { key: 'legal.guest-agreement', version: AGREEMENT_VERSIONS.GUEST, title: 'Guest Agreement' },
  { key: 'legal.host-agreement', version: AGREEMENT_VERSIONS.HOST, title: 'Host Agreement' },
  { key: 'legal.cancellation-policy', version: AGREEMENT_VERSIONS.TERMS, title: 'Cancellation Policy' },
].map(({ key, version, title }) => ({
  key,
  version,
  content: {
    title,
    markdown: `# ${title}

*This is placeholder text. The final ${title} will be supplied by Rento Vroom's legal adviser before launch.*

Version ${version}.`,
  },
}));
