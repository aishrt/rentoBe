import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';

/*
 * Account security emails (plan §7). The "changed" ones are sent even when the person made the change
 * themselves: if they didn't, it's their prompt to reset their password and contact support.
 */

export interface ResetPasswordProps {
  firstName: string;
  resetUrl: string;
}

export function ResetPasswordEmail({ firstName, resetUrl }: ResetPasswordProps) {
  return (
    <EmailLayout preview="Choose a new password for your Rento Vroom account.">
      <EmailHeading>Reset your password, {firstName}</EmailHeading>
      <EmailText>We got a request to reset the password for your Rento Vroom account.</EmailText>
      <EmailButton href={resetUrl}>Choose a new password</EmailButton>
      <EmailText>This link works once and expires in 1 hour.</EmailText>
      <EmailText>
        If you didn't ask for this, you can ignore this email: your password stays the same.
      </EmailText>
    </EmailLayout>
  );
}

export interface PasswordChangedProps {
  firstName: string;
  resetUrl: string;
}

export function PasswordChangedEmail({ firstName, resetUrl }: PasswordChangedProps) {
  return (
    <EmailLayout preview="The password for your Rento Vroom account was changed.">
      <EmailHeading>Your password was changed</EmailHeading>
      <EmailText>
        Kia ora {firstName}, the password for your Rento Vroom account was just changed, and every other
        device was signed out.
      </EmailText>
      <EmailText>
        If this wasn't you, reset your password straight away and let our support team know.
      </EmailText>
      <EmailButton href={resetUrl}>Reset my password</EmailButton>
    </EmailLayout>
  );
}

export interface ConfirmEmailChangeProps {
  firstName: string;
  newEmail: string;
  confirmUrl: string;
}

export function ConfirmEmailChangeEmail({ firstName, newEmail, confirmUrl }: ConfirmEmailChangeProps) {
  return (
    <EmailLayout preview="Confirm your new email address.">
      <EmailHeading>Confirm your new email, {firstName}</EmailHeading>
      <EmailText>
        You asked to use {newEmail} for your Rento Vroom account. Your current address keeps working until you
        confirm this one.
      </EmailText>
      <EmailButton href={confirmUrl}>Use this email address</EmailButton>
      <EmailText>This link works once and expires in 24 hours.</EmailText>
      <EmailText>If you didn't ask for this, you can ignore this email.</EmailText>
    </EmailLayout>
  );
}

export interface EmailChangedProps {
  firstName: string;
  newEmail: string;
  resetUrl: string;
}

export function EmailChangedEmail({ firstName, newEmail, resetUrl }: EmailChangedProps) {
  return (
    <EmailLayout preview="The email address for your Rento Vroom account was changed.">
      <EmailHeading>Your email address was changed</EmailHeading>
      <EmailText>
        Kia ora {firstName}, your Rento Vroom account now uses {newEmail}. We'll send everything there from
        now on, and this address no longer signs in.
      </EmailText>
      <EmailText>
        If this wasn't you, contact our support team straight away, and reset your password.
      </EmailText>
      <EmailButton href={resetUrl}>Reset my password</EmailButton>
    </EmailLayout>
  );
}
