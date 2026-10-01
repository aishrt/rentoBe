import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';

/* Staff portal emails (plan §6.2). Support team members join only through this invitation. */

export interface StaffInviteProps {
  firstName: string;
  /** The admin's first name. */
  invitedBy: string;
  acceptUrl: string;
  validDays: number;
}

export function StaffInviteEmail({ firstName, invitedBy, acceptUrl, validDays }: StaffInviteProps) {
  return (
    <EmailLayout preview="You're invited to join the Rento Vroom support team.">
      <EmailHeading>Join the support team, {firstName}</EmailHeading>
      <EmailText>
        {invitedBy} has invited you to the Rento Vroom staff portal, as a member of the support team.
      </EmailText>
      <EmailButton href={acceptUrl}>Accept the invitation</EmailButton>
      <EmailText>
        You'll choose a password, then log in to the staff portal. This link works once and expires in{' '}
        {validDays} days.
      </EmailText>
      <EmailText>If you weren't expecting this, you can ignore this email.</EmailText>
    </EmailLayout>
  );
}
