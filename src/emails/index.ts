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
import {
  BookingCancelledEmail,
  BookingConfirmedGuestEmail,
  BookingConfirmedHostEmail,
  BookingDeclinedEmail,
  BookingRequestHostEmail,
  BookingRequestSentEmail,
  PaymentFailedEmail,
  PaymentReceiptEmail,
  RefundIssuedEmail,
  RequestExpiredHostEmail,
  type BookingCancelledProps,
  type BookingConfirmedGuestProps,
  type BookingConfirmedHostProps,
  type BookingDeclinedProps,
  type BookingRequestHostProps,
  type BookingRequestSentProps,
  type PaymentFailedProps,
  type PaymentReceiptProps,
  type RefundIssuedProps,
  type RequestExpiredHostProps,
} from './templates/booking-emails.js';
import {
  HostApplicationDecisionEmail,
  HostApplicationReceivedEmail,
  ListingDecisionEmail,
  ListingSubmittedEmail,
  listingDecisionSubjects,
  type HostApplicationDecisionProps,
  type HostApplicationReceivedProps,
  type ListingDecisionProps,
  type ListingSubmittedProps,
} from './templates/host-emails.js';
import { SupportTicketReceivedEmail, type SupportTicketReceivedProps } from './templates/support-emails.js';
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
  supportTicketReceived: defineTemplate<SupportTicketReceivedProps>({
    subject: ({ ref }) => `We've got your message (${ref})`,
    component: SupportTicketReceivedEmail,
  }),
  hostApplicationReceived: defineTemplate<HostApplicationReceivedProps>({
    subject: () => "We've got your Host application",
    component: HostApplicationReceivedEmail,
  }),
  hostApplicationDecision: defineTemplate<HostApplicationDecisionProps>({
    subject: ({ approved }) =>
      approved ? "You're approved to host on Rento Vroom" : 'About your Host application',
    component: HostApplicationDecisionEmail,
  }),
  listingSubmitted: defineTemplate<ListingSubmittedProps>({
    subject: ({ vehicleTitle }) => `Your ${vehicleTitle} is under review`,
    component: ListingSubmittedEmail,
  }),
  listingDecision: defineTemplate<ListingDecisionProps>({
    subject: ({ decision, vehicleTitle }) => listingDecisionSubjects[decision](vehicleTitle),
    component: ListingDecisionEmail,
  }),
  bookingRequestHost: defineTemplate<BookingRequestHostProps>({
    subject: ({ guestFirstName, vehicleTitle }) =>
      `Booking request from ${guestFirstName} for your ${vehicleTitle}`,
    component: BookingRequestHostEmail,
  }),
  bookingRequestSent: defineTemplate<BookingRequestSentProps>({
    subject: ({ hostFirstName }) => `Your booking request is with ${hostFirstName}`,
    component: BookingRequestSentEmail,
  }),
  bookingConfirmedGuest: defineTemplate<BookingConfirmedGuestProps>({
    subject: ({ vehicleTitle, ref }) => `You're booked: ${vehicleTitle} (${ref})`,
    component: BookingConfirmedGuestEmail,
  }),
  bookingConfirmedHost: defineTemplate<BookingConfirmedHostProps>({
    subject: ({ guestFirstName, vehicleTitle }) => `${guestFirstName} has booked your ${vehicleTitle}`,
    component: BookingConfirmedHostEmail,
  }),
  bookingDeclined: defineTemplate<BookingDeclinedProps>({
    subject: ({ outcome, vehicleTitle }) =>
      outcome === 'DECLINED'
        ? `Your request for the ${vehicleTitle} was declined`
        : `Your request for the ${vehicleTitle} expired`,
    component: BookingDeclinedEmail,
  }),
  requestExpiredHost: defineTemplate<RequestExpiredHostProps>({
    subject: ({ guestFirstName }) => `${guestFirstName}'s booking request expired`,
    component: RequestExpiredHostEmail,
  }),
  bookingCancelled: defineTemplate<BookingCancelledProps>({
    subject: ({ ref }) => `Booking ${ref} is cancelled`,
    component: BookingCancelledEmail,
  }),
  paymentReceipt: defineTemplate<PaymentReceiptProps>({
    subject: ({ ref, gstNumber }) => `${gstNumber ? 'Tax invoice' : 'Receipt'} for booking ${ref}`,
    component: PaymentReceiptEmail,
  }),
  paymentFailed: defineTemplate<PaymentFailedProps>({
    subject: ({ vehicleTitle }) => `Your payment for the ${vehicleTitle} didn't go through`,
    component: PaymentFailedEmail,
  }),
  refundIssued: defineTemplate<RefundIssuedProps>({
    subject: ({ ref }) => `Refund for booking ${ref}`,
    component: RefundIssuedEmail,
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
