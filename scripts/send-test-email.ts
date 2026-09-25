/**
 * Sends the welcome email to check the mail setup end to end.
 *
 *   npm run email:test -- you@example.com
 *
 * With MAIL_DRIVER=console the email is saved to backend/.mail/ instead of being sent.
 */
import { sendEmail } from '../src/emails/index.js';
import { env } from '../src/env.js';

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run email:test -- you@example.com');
  process.exit(1);
}

sendEmail({ to, template: 'welcome', props: { firstName: 'there', browseUrl: env.FRONTEND_URL } })
  .then((result) => console.log(`Email handled by ${result.provider} (id ${result.id})`))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
