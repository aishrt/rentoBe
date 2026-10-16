import { sendEmail, type EmailTemplateName, type SendEmailInput } from '../../emails/index.js';
import type { JobContext } from './index.js';

/** Any template with its own props, so `enqueue('email.send', …)` checks the props against the template. */
export type EmailJobPayload = { [Name in EmailTemplateName]: SendEmailInput<Name> }[EmailTemplateName];

/**
 * `email.send` (plan §4.3): renders the template and sends it, with up to 5 attempts. The job's id is the
 * provider's idempotency key, so an attempt retried after a timeout (the provider took the email, but the job
 * wasn't marked done) doesn't send it twice.
 */
export async function sendEmailJob(payload: EmailJobPayload, { job, log }: JobContext): Promise<void> {
  const sent = await sendEmail({ ...payload, idempotencyKey: payload.idempotencyKey ?? `job:${job.id}` });
  log.info({ emailId: sent.id, provider: sent.provider, template: payload.template }, 'Email sent');
}
