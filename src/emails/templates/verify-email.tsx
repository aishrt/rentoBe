import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';

export interface VerifyEmailProps {
  firstName: string;
  verifyUrl: string;
}

export function VerifyEmail({ firstName, verifyUrl }: VerifyEmailProps) {
  return (
    <EmailLayout preview="Confirm your email address to finish setting up your account.">
      <EmailHeading>Confirm your email, {firstName}</EmailHeading>
      <EmailText>
        Thanks for joining Rento Vroom. Please confirm this is your email address, so we can send you your
        bookings and receipts.
      </EmailText>
      <EmailButton href={verifyUrl}>Confirm my email</EmailButton>
      <EmailText>This link works once and expires in 24 hours.</EmailText>
      <EmailText>If you didn't create a Rento Vroom account, you can ignore this email.</EmailText>
    </EmailLayout>
  );
}
