import { EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';

/* Support emails (plan §7): the Contact Us form's confirmation. */

export interface SupportTicketReceivedProps {
  name: string;
  ref: string;
  subject: string;
}

export function SupportTicketReceivedEmail({ name, ref, subject }: SupportTicketReceivedProps) {
  return (
    <EmailLayout preview={`We've got your message (${ref}). Our support team will reply by email.`}>
      <EmailHeading>We've got your message</EmailHeading>
      <EmailText>
        Kia ora {name}, thanks for getting in touch about "{subject}". Our support team will reply to this
        email address, usually within one working day.
      </EmailText>
      <EmailText>Your reference is {ref}. Quote it if you contact us again about the same thing.</EmailText>
      <EmailText>
        If it's an emergency on the road, call 111 first. For a problem with a trip that's happening now,
        report it from the trip.
      </EmailText>
    </EmailLayout>
  );
}
