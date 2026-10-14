import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';
import { EmailDetails, EmailNote } from '../components/email-details.js';

/*
 * Trip emails (plan §7): messages, pickup and return reminders. Times arrive formatted in NZ time.
 */

export interface NewMessageProps {
  firstName: string;
  senderFirstName: string;
  vehicleTitle: string;
  ref: string;
  /** The latest message, contact details hidden if the booking isn't confirmed. */
  snippet: string;
  /** How many messages are waiting. */
  count: number;
  url: string;
  /** Turns these emails off without signing in (plan §7: non-essential email people choose). */
  unsubscribeUrl?: string;
}

/** A message still unread 10 minutes after it was sent (plan §4.3, `messages.unreadEmail`). */
export function NewMessageEmail(props: NewMessageProps) {
  const many = props.count > 1;
  return (
    <EmailLayout preview={`${props.senderFirstName}: ${props.snippet}`}>
      <EmailHeading>
        {many ? `${props.count} new messages` : 'New message'} from {props.senderFirstName}
      </EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, {props.senderFirstName} sent you {many ? 'messages' : 'a message'} about
        booking {props.ref}, the {props.vehicleTitle}:
      </EmailText>
      <EmailNote>“{props.snippet}”</EmailNote>
      <EmailButton href={props.url}>Read and reply</EmailButton>
      <EmailNote>
        Keep your conversation on Rento Vroom: messages here are part of the trip’s record if anything goes
        wrong.
      </EmailNote>
      {props.unsubscribeUrl && (
        <EmailNote>
          Don’t want these emails? <a href={props.unsubscribeUrl}>Turn off emails about unread messages</a>.
          You’ll still see new messages in the app.
        </EmailNote>
      )}
    </EmailLayout>
  );
}

export type ReminderKind = 'PICKUP' | 'RETURN';

export interface TripReminderProps {
  firstName: string;
  /** Who it's for: the Guest picks up and returns, the Host hands over and takes back. */
  role: 'GUEST' | 'HOST';
  kind: ReminderKind;
  otherFirstName: string;
  ref: string;
  vehicleTitle: string;
  /** "Mon, 12 Oct 2026, 10:00 am". */
  when: string;
  /** "Tomorrow" or "In 2 hours". */
  inWords: string;
  place: string;
  url: string;
  /** The Guest still has to confirm their email address before the trip starts (plan §6.1). */
  verifyEmailUrl?: string;
}

const REMINDER_HEADINGS: Record<ReminderKind, Record<'GUEST' | 'HOST', string>> = {
  PICKUP: { GUEST: 'Your trip starts soon', HOST: 'Your guest picks up soon' },
  RETURN: { GUEST: 'Time to head back', HOST: 'Your car comes back soon' },
};

export const tripReminderSubjects = (props: TripReminderProps) =>
  props.kind === 'PICKUP'
    ? props.role === 'GUEST'
      ? `${props.inWords}: pick up the ${props.vehicleTitle}`
      : `${props.inWords}: ${props.otherFirstName} picks up your ${props.vehicleTitle}`
    : props.role === 'GUEST'
      ? `${props.inWords}: return the ${props.vehicleTitle}`
      : `${props.inWords}: ${props.otherFirstName} returns your ${props.vehicleTitle}`;

/** `reminder.pickup` (24 h and 2 h before) and `reminder.return` (2 h before), plan §4.3. */
export function TripReminderEmail(props: TripReminderProps) {
  const pickup = props.kind === 'PICKUP';
  return (
    <EmailLayout preview={tripReminderSubjects(props)}>
      <EmailHeading>{REMINDER_HEADINGS[props.kind][props.role]}</EmailHeading>
      <EmailText>
        Kia ora {props.firstName},{' '}
        {pickup
          ? props.role === 'GUEST'
            ? `your trip in the ${props.vehicleTitle} starts ${props.when} (NZ time). ${props.otherFirstName} will meet you for the check-in photos.`
            : `${props.otherFirstName} picks up your ${props.vehicleTitle} ${props.when} (NZ time). Do the check-in together: photos, odometer and fuel.`
          : props.role === 'GUEST'
            ? `please return the ${props.vehicleTitle} by ${props.when} (NZ time), with the fuel or charge as the trip's fuel policy says.`
            : `${props.otherFirstName} returns your ${props.vehicleTitle} by ${props.when} (NZ time). Check it over together at check-out.`}
      </EmailText>
      <EmailDetails
        rows={[
          { label: 'Car', value: props.vehicleTitle },
          { label: pickup ? 'Pick-up' : 'Return', value: `${props.when} (NZ time)` },
          { label: 'Where', value: props.place },
          { label: 'Booking', value: props.ref },
        ]}
      />
      <EmailButton href={props.url}>{pickup ? 'Open your trip' : 'Start check-out'}</EmailButton>
      {props.verifyEmailUrl && (
        <EmailNote>
          Please confirm your email address before your trip starts:{' '}
          <a href={props.verifyEmailUrl}>confirm it here</a>.
        </EmailNote>
      )}
      <EmailNote>In an emergency on the road, call 111 first.</EmailNote>
    </EmailLayout>
  );
}

export interface TripNoticeProps {
  firstName: string;
  /** Also the email's subject. */
  heading: string;
  paragraphs: string[];
  /** Details shown as a table, e.g. the car, the time and the booking reference. */
  rows?: { label: string; value: string }[];
  buttonLabel: string;
  url: string;
  note?: string;
}

/**
 * The shorter trip and account notices (plan §7): check-in not done, late return, a condition report to
 * confirm, trip completed, extra charges, payouts, incidents and verification results. Each caller
 * writes its own words.
 */
export function TripNoticeEmail(props: TripNoticeProps) {
  return (
    <EmailLayout preview={props.paragraphs[0] ?? props.heading}>
      <EmailHeading>{props.heading}</EmailHeading>
      {props.paragraphs.map((paragraph, index) => (
        <EmailText key={index}>
          {index === 0
            ? `Kia ora ${props.firstName}, ${paragraph.charAt(0).toLowerCase()}${paragraph.slice(1)}`
            : paragraph}
        </EmailText>
      ))}
      {props.rows && props.rows.length > 0 && <EmailDetails rows={props.rows} />}
      <EmailButton href={props.url}>{props.buttonLabel}</EmailButton>
      {props.note && <EmailNote>{props.note}</EmailNote>}
    </EmailLayout>
  );
}

export interface StaffAlertProps {
  firstName: string;
  title: string;
  body: string;
  url: string;
}

/** An alert for support staff: a possible no-show, a missing check-out, a failed refund (plan §7). */
export function StaffAlertEmail(props: StaffAlertProps) {
  return (
    <EmailLayout preview={props.body}>
      <EmailHeading>{props.title}</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, {props.body}
      </EmailText>
      <EmailButton href={props.url}>Open in the staff portal</EmailButton>
    </EmailLayout>
  );
}
