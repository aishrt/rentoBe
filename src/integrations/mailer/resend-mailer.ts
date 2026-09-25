import { Resend } from 'resend';
import { MailerError, type Mailer } from './mailer.types.js';

interface ResendMailerOptions {
  apiKey: string;
  /** e.g. "Rento Vroom <hello@mail.rentovroom.co.nz>"; the domain must be verified in Resend. */
  from: string;
  replyTo?: string;
  /** Injected in tests so no real email is sent. */
  client?: Pick<Resend, 'emails'>;
}

export function createResendMailer({ apiKey, from, replyTo, client }: ResendMailerOptions): Mailer {
  const resend = client ?? new Resend(apiKey);

  return {
    provider: 'resend',
    async send(message) {
      const { data, error } = await resend.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...((message.replyTo ?? replyTo) && { replyTo: message.replyTo ?? replyTo }),
      });
      if (error || !data) {
        throw new MailerError(`Resend did not accept the email: ${error?.message ?? 'empty response'}`);
      }
      return { id: data.id, provider: 'resend' };
    },
  };
}
