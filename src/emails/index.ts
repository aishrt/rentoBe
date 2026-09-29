import type { ReactElement } from 'react';
import { render, toPlainText } from 'react-email';
import { getMailer, type Mailer, type SentEmail } from '../integrations/mailer/index.js';
import {
  ConfirmEmailChangeEmail,
  EmailChangedEmail,
  MfaChangedEmail,
  PasswordChangedEmail,
  ResetPasswordEmail,
  mfaChangedSubjects,
  type ConfirmEmailChangeProps,
  type EmailChangedProps,
  type MfaChangedProps,
  type PasswordChangedProps,
  type ResetPasswordProps,
} from './templates/account-emails.js';
import { VerifyEmail, type VerifyEmailProps } from './templates/verify-email.js';
import { WelcomeEmail, type WelcomeEmailProps } from './templates/welcome-email.js';

interface EmailTemplate<Props> {
  subject: (props: Props) => string;
  component: (props: Props) => ReactElement;
}

const defineTemplate = <Props>(template: EmailTemplate<Props>) => template;

/** Every email the platform can send (plan §7). */
export const emailTemplates = {
  welcome: defineTemplate<WelcomeEmailProps>({
    subject: ({ firstName }) => `Welcome to Rento Vroom, ${firstName}`,
    component: WelcomeEmail,
  }),
  verifyEmail: defineTemplate<VerifyEmailProps>({
    subject: () => 'Confirm your email address',
    component: VerifyEmail,
  }),
  resetPassword: defineTemplate<ResetPasswordProps>({
    subject: () => 'Reset your Rento Vroom password',
    component: ResetPasswordEmail,
  }),
  passwordChanged: defineTemplate<PasswordChangedProps>({
    subject: () => 'Your Rento Vroom password was changed',
    component: PasswordChangedEmail,
  }),
  confirmEmailChange: defineTemplate<ConfirmEmailChangeProps>({
    subject: () => 'Confirm your new email address',
    component: ConfirmEmailChangeEmail,
  }),
  emailChanged: defineTemplate<EmailChangedProps>({
    subject: () => 'Your Rento Vroom email address was changed',
    component: EmailChangedEmail,
  }),
  mfaChanged: defineTemplate<MfaChangedProps>({
    subject: ({ change }) => mfaChangedSubjects[change],
    component: MfaChangedEmail,
  }),
};

export type EmailTemplateName = keyof typeof emailTemplates;
export type EmailTemplateProps<Name extends EmailTemplateName> = Parameters<
  (typeof emailTemplates)[Name]['component']
>[0];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail<Name extends EmailTemplateName>(
  name: Name,
  props: EmailTemplateProps<Name>,
): Promise<RenderedEmail> {
  const template = emailTemplates[name] as EmailTemplate<EmailTemplateProps<Name>>;
  const html = await render(template.component(props));
  return { subject: template.subject(props), html, text: toPlainText(html) };
}

export interface SendEmailInput<Name extends EmailTemplateName> {
  to: string | string[];
  template: Name;
  props: EmailTemplateProps<Name>;
  replyTo?: string;
}

/**
 * Renders a template and sends it straight away. Features send email through the job queue
 * instead, `enqueue('email.send', …)`, which calls this with retries (plan §4.3).
 */
export async function sendEmail<Name extends EmailTemplateName>(
  { to, template, props, replyTo }: SendEmailInput<Name>,
  mailer: Mailer = getMailer(),
): Promise<SentEmail> {
  const email = await renderEmail(template, props);
  return mailer.send({ to, ...email, ...(replyTo && { replyTo }) });
}
