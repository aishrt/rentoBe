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

export type MfaChange = 'ENABLED' | 'DEVICE_ADDED' | 'DEVICE_REMOVED' | 'DISABLED';

export interface MfaChangedProps {
  firstName: string;
  change: MfaChange;
  /** The authenticator app added or removed. */
  deviceName?: string;
  resetUrl: string;
}

export const mfaChangedSubjects: Record<MfaChange, string> = {
  ENABLED: 'Two-factor sign-in is on for your Rento Vroom account',
  DEVICE_ADDED: 'An authenticator app was added to your Rento Vroom account',
  DEVICE_REMOVED: 'An authenticator app was removed from your Rento Vroom account',
  DISABLED: 'Two-factor sign-in was turned off for your Rento Vroom account',
};

const mfaChangedHeadings: Record<MfaChange, string> = {
  ENABLED: 'Two-factor sign-in is on',
  DEVICE_ADDED: 'An authenticator app was added',
  DEVICE_REMOVED: 'An authenticator app was removed',
  DISABLED: 'Two-factor sign-in is off',
};

function mfaChangeDetail(change: MfaChange, deviceName = 'Your authenticator app'): string {
  switch (change) {
    case 'ENABLED':
      return `signing in to your Rento Vroom account now also needs a code from ${deviceName}, and your other devices were signed out.`;
    case 'DEVICE_ADDED':
      return `${deviceName} can now give the codes for signing in to your Rento Vroom account.`;
    case 'DEVICE_REMOVED':
      return `${deviceName} no longer gives codes for signing in to your Rento Vroom account.`;
    case 'DISABLED':
      return 'signing in to your Rento Vroom account now needs only your password.';
  }
}

/** Staff two-factor sign-in was turned on or off, or an authenticator app was added or removed. */
export function MfaChangedEmail({ firstName, change, deviceName, resetUrl }: MfaChangedProps) {
  return (
    <EmailLayout preview={mfaChangedSubjects[change]}>
      <EmailHeading>{mfaChangedHeadings[change]}</EmailHeading>
      <EmailText>
        Kia ora {firstName}, {mfaChangeDetail(change, deviceName)}
      </EmailText>
      <EmailText>If this wasn't you, reset your password straight away and let the admin know.</EmailText>
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
