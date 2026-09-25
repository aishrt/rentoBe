export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SentEmail {
  /** The provider's message id, stored on the notification later for delivery status (plan §7). */
  id: string;
  provider: Mailer['provider'];
}

/** Every email goes through this interface, so Resend can be swapped for AWS SES (plan §7). */
export interface Mailer {
  readonly provider: 'resend' | 'console';
  send(message: EmailMessage): Promise<SentEmail>;
}

export class MailerError extends Error {
  override name = 'MailerError';
}
