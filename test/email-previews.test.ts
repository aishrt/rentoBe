import { describe, expect, it } from 'vitest';
import { emailTemplates, renderEmail, type EmailTemplateName } from '../src/emails/index.js';
import { previewProps } from '../src/emails/preview-props.js';

describe('email previews (npm run email:dev)', () => {
  it('renders every template with its sample details', async () => {
    for (const name of Object.keys(emailTemplates) as EmailTemplateName[]) {
      const email = await renderEmail(name, previewProps[name]);
      expect(email.subject, name).not.toBe('');
      expect(email.html, name).toContain('Rento Vroom');
      // The plain-text version puts headings in capitals.
      expect(email.text.toLowerCase(), name).toContain('kiri');
    }
  });
});
