import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';
import { EmailNote } from '../components/email-details.js';

/* Host emails (plan §7): the Host application and listing reviews. */

export interface HostApplicationReceivedProps {
  firstName: string;
  listUrl: string;
}

export function HostApplicationReceivedEmail({ firstName, listUrl }: HostApplicationReceivedProps) {
  return (
    <EmailLayout preview="We've got your Host application. You can start adding your car now.">
      <EmailHeading>Thanks for applying to host, {firstName}</EmailHeading>
      <EmailText>
        We've got your Host application and our team will review it, usually within one working day. You don't
        have to wait: add your car now, and it can go live as soon as both are approved.
      </EmailText>
      <EmailButton href={listUrl}>Add your car</EmailButton>
    </EmailLayout>
  );
}

export interface HostApplicationDecisionProps {
  firstName: string;
  approved: boolean;
  notes?: string;
  url: string;
}

export function HostApplicationDecisionEmail({
  firstName,
  approved,
  notes,
  url,
}: HostApplicationDecisionProps) {
  return (
    <EmailLayout
      preview={approved ? 'You can now host on Rento Vroom.' : 'An update on your Host application.'}
    >
      <EmailHeading>
        {approved ? `You're approved to host, ${firstName}` : 'About your Host application'}
      </EmailHeading>
      {approved ? (
        <EmailText>
          Welcome aboard. Your listings can go live as soon as each one is approved, and you'll hear from us
          the moment a guest books.
        </EmailText>
      ) : (
        <EmailText>
          Kia ora {firstName}, we're sorry, but we can't approve your Host application at the moment.
        </EmailText>
      )}
      {notes && <EmailText>A note from our team: {notes}</EmailText>}
      <EmailButton href={url}>{approved ? 'Go to your listings' : 'Contact support'}</EmailButton>
    </EmailLayout>
  );
}

export interface ListingSubmittedProps {
  firstName: string;
  vehicleTitle: string;
  url: string;
}

export function ListingSubmittedEmail({ firstName, vehicleTitle, url }: ListingSubmittedProps) {
  return (
    <EmailLayout preview={`Your ${vehicleTitle} is with our team for review.`}>
      <EmailHeading>Your {vehicleTitle} is under review</EmailHeading>
      <EmailText>
        Thanks, {firstName}. Our team checks every listing's details, documents and photos, usually within one
        working day. We'll email you as soon as it's approved, or if anything needs changing.
      </EmailText>
      <EmailButton href={url}>See your listing</EmailButton>
    </EmailLayout>
  );
}

export type ListingDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';

export interface ListingDecisionProps {
  firstName: string;
  vehicleTitle: string;
  decision: ListingDecision;
  notes?: string;
  url: string;
}

export const listingDecisionSubjects: Record<ListingDecision, (title: string) => string> = {
  APPROVED: (title) => `Your ${title} is live on Rento Vroom`,
  CHANGES_REQUESTED: (title) => `A few changes needed on your ${title}`,
  REJECTED: (title) => `About your ${title} listing`,
};

export function ListingDecisionEmail({
  firstName,
  vehicleTitle,
  decision,
  notes,
  url,
}: ListingDecisionProps) {
  return (
    <EmailLayout preview={listingDecisionSubjects[decision](vehicleTitle)}>
      <EmailHeading>
        {decision === 'APPROVED'
          ? `Your ${vehicleTitle} is live`
          : decision === 'CHANGES_REQUESTED'
            ? 'A few changes needed'
            : 'About your listing'}
      </EmailHeading>
      <EmailText>
        {decision === 'APPROVED'
          ? `Great news, ${firstName}: guests can now find and book your ${vehicleTitle}. Keep your calendar up to date so you only get bookings you can take.`
          : decision === 'CHANGES_REQUESTED'
            ? `Kia ora ${firstName}, our team reviewed your ${vehicleTitle} and needs a few changes before it can go live.`
            : `Kia ora ${firstName}, we're sorry, but we can't approve your ${vehicleTitle} for Rento Vroom.`}
      </EmailText>
      {notes && <EmailText>A note from our team: {notes}</EmailText>}
      <EmailButton href={url}>
        {decision === 'CHANGES_REQUESTED' ? 'Update your listing' : 'See your listing'}
      </EmailButton>
      {decision === 'APPROVED' && (
        <EmailNote>
          New photos and documents you add later are checked before they show on your listing.
        </EmailNote>
      )}
    </EmailLayout>
  );
}
