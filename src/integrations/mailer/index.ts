import type { Logger } from 'pino';
import { env, type Env } from '../../env.js';
import { logger } from '../logger.js';
import { createConsoleMailer } from './console-mailer.js';
import type { Mailer } from './mailer.types.js';
import { createResendMailer } from './resend-mailer.js';

export type { EmailMessage, Mailer, SentEmail } from './mailer.types.js';
export { MailerError } from './mailer.types.js';

type MailerConfig = Pick<Env, 'MAIL_DRIVER' | 'RESEND_API_KEY' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>;

/** Picks the mailer from MAIL_DRIVER: "console" locally, "resend" on staging and production. */
export function createMailer(config: MailerConfig, log: Logger = logger): Mailer {
  if (config.MAIL_DRIVER === 'resend') {
    if (!config.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when MAIL_DRIVER=resend');
    return createResendMailer({
      apiKey: config.RESEND_API_KEY,
      from: config.EMAIL_FROM,
      replyTo: config.EMAIL_REPLY_TO,
    });
  }
  return createConsoleMailer({ logger: log });
}

let mailer: Mailer | undefined;

export function getMailer(): Mailer {
  mailer ??= createMailer(env);
  return mailer;
}
