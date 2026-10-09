import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';
import {
  EmailDetails,
  EmailNote,
  EmailPriceTable,
  type EmailPriceLine,
} from '../components/email-details.js';

/*
 * Booking and payment emails (plan §7). Amounts and times arrive formatted in NZD and NZ time, so a
 * template never does arithmetic.
 */

interface TripBasics {
  firstName: string;
  ref: string;
  vehicleTitle: string;
  /** "Mon, 12 Oct 2026, 10:00 am". */
  start: string;
  end: string;
  url: string;
}

const tripRows = ({ ref, vehicleTitle, start, end }: TripBasics) => [
  { label: 'Car', value: vehicleTitle },
  { label: 'Pick-up', value: `${start} (NZ time)` },
  { label: 'Return', value: `${end} (NZ time)` },
  { label: 'Booking', value: ref },
];

export interface BookingRequestHostProps extends TripBasics {
  guestFirstName: string;
  pickupLabel: string;
  /** What the Host earns, e.g. "$213.60". */
  payout: string;
  /** When the request expires if unanswered. */
  expiresAt: string;
}

export function BookingRequestHostEmail(props: BookingRequestHostProps) {
  return (
    <EmailLayout
      preview={`${props.guestFirstName} would like to book your ${props.vehicleTitle}. Answer within 24 hours.`}
    >
      <EmailHeading>New booking request</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, {props.guestFirstName} would like to book your {props.vehicleTitle}. Their
        card is authorised: accept and the booking is confirmed straight away.
      </EmailText>
      <EmailDetails
        rows={[
          ...tripRows(props),
          { label: 'Pick-up at', value: props.pickupLabel },
          { label: 'You earn', value: props.payout },
        ]}
      />
      <EmailButton href={props.url}>Accept or decline</EmailButton>
      <EmailNote>
        The request expires at {props.expiresAt} if you don't answer, and the guest's card is released.
      </EmailNote>
    </EmailLayout>
  );
}

export interface BookingRequestSentProps extends TripBasics {
  hostFirstName: string;
  total: string;
  expiresAt: string;
}

export function BookingRequestSentEmail(props: BookingRequestSentProps) {
  return (
    <EmailLayout
      preview={`Your request is with ${props.hostFirstName}. We'll email you as soon as they answer.`}
    >
      <EmailHeading>Your request is with {props.hostFirstName}</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, we've sent your request to book the {props.vehicleTitle}. Your card is
        authorised for {props.total} but won't be charged unless {props.hostFirstName} accepts.
      </EmailText>
      <EmailDetails rows={tripRows(props)} />
      <EmailButton href={props.url}>View your request</EmailButton>
      <EmailNote>
        If the host hasn't answered by {props.expiresAt}, the request expires and the authorisation is
        released.
      </EmailNote>
    </EmailLayout>
  );
}

export interface BookingVerificationReviewProps extends TripBasics {
  total: string;
  /** When the booking expires if the check isn't finished. */
  expiresAt: string;
  /** Set for a car whose Host also has to accept the booking. */
  hostFirstName?: string;
}

/** To a Guest who paid while their identity check or driver licence was with support (plan §8.2). */
export function BookingVerificationReviewEmail(props: BookingVerificationReviewProps) {
  return (
    <EmailLayout
      preview={`We're finishing the check of your ID and licence. Your ${props.vehicleTitle} is held for you in the meantime.`}
    >
      <EmailHeading>We're checking your details</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, your ID or driver licence needs a closer look from our team, so your
        booking of the {props.vehicleTitle} isn't confirmed yet. The dates are held for you, and your card is
        authorised for {props.total} but won't be charged until the check is approved
        {props.hostFirstName ? ` and ${props.hostFirstName} accepts` : ''}.
      </EmailText>
      <EmailDetails rows={tripRows(props)} />
      <EmailButton href={props.url}>View your booking</EmailButton>
      <EmailNote>
        We'll email you as soon as it's decided. If it isn't by {props.expiresAt}, the booking expires and the
        authorisation is released.
      </EmailNote>
    </EmailLayout>
  );
}

export interface BookingConfirmedGuestProps extends TripBasics {
  hostFirstName: string;
  hostPhone?: string;
  pickupLabel: string;
  pickupAddress?: string;
  pickupInstructions?: string;
  total: string;
  /** Shown when the Guest still has to confirm their email before the trip (plan §6.1). */
  verifyEmailUrl?: string;
}

export function BookingConfirmedGuestEmail(props: BookingConfirmedGuestProps) {
  return (
    <EmailLayout preview={`You're booked: ${props.vehicleTitle}, ${props.start}.`}>
      <EmailHeading>You're booked, {props.firstName}</EmailHeading>
      <EmailText>
        Your {props.vehicleTitle} is confirmed with {props.hostFirstName}. Here's everything you need for
        pick-up.
      </EmailText>
      <EmailDetails
        rows={[
          ...tripRows(props),
          {
            label: 'Pick-up at',
            value: props.pickupAddress ? `${props.pickupLabel}, ${props.pickupAddress}` : props.pickupLabel,
          },
          ...(props.pickupInstructions ? [{ label: 'Instructions', value: props.pickupInstructions }] : []),
          ...(props.hostPhone ? [{ label: `${props.hostFirstName}'s mobile`, value: props.hostPhone }] : []),
          { label: 'Paid', value: props.total },
        ]}
      />
      <EmailButton href={props.url}>View your trip</EmailButton>
      {props.verifyEmailUrl && (
        <EmailText>
          One more thing: please confirm your email address before your trip starts.{' '}
          <a href={props.verifyEmailUrl}>Confirm my email</a>.
        </EmailText>
      )}
      <EmailNote>
        At pick-up you'll take a few photos of the car with your host. In an emergency, call 111.
      </EmailNote>
    </EmailLayout>
  );
}

export interface BookingConfirmedHostProps extends TripBasics {
  guestFirstName: string;
  guestPhone?: string;
  pickupLabel: string;
  payout: string;
}

export function BookingConfirmedHostEmail(props: BookingConfirmedHostProps) {
  return (
    <EmailLayout preview={`${props.guestFirstName} has booked your ${props.vehicleTitle}.`}>
      <EmailHeading>{props.guestFirstName} has booked your car</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, your {props.vehicleTitle} is booked. The dates are blocked on your
        calendar.
      </EmailText>
      <EmailDetails
        rows={[
          ...tripRows(props),
          { label: 'Pick-up at', value: props.pickupLabel },
          ...(props.guestPhone
            ? [{ label: `${props.guestFirstName}'s mobile`, value: props.guestPhone }]
            : []),
          { label: 'You earn', value: props.payout },
        ]}
      />
      <EmailButton href={props.url}>View the booking</EmailButton>
    </EmailLayout>
  );
}

/**
 * DECLINED and EXPIRED: the Host's answer, or none. VERIFICATION_REJECTED and VERIFICATION_EXPIRED: the
 * Guest's identity check wasn't approved, or wasn't finished in time (plan §8.2).
 */
export type RequestOutcome = 'DECLINED' | 'EXPIRED' | 'VERIFICATION_REJECTED' | 'VERIFICATION_EXPIRED';

export const requestOutcomeHeadings: Record<RequestOutcome, string> = {
  DECLINED: 'Your request was declined',
  EXPIRED: 'Your request expired',
  VERIFICATION_REJECTED: "We couldn't confirm your booking",
  VERIFICATION_EXPIRED: 'Your booking expired',
};

export interface BookingDeclinedProps {
  firstName: string;
  vehicleTitle: string;
  start: string;
  outcome: RequestOutcome;
  searchUrl: string;
}

export function BookingDeclinedEmail({
  firstName,
  vehicleTitle,
  start,
  outcome,
  searchUrl,
}: BookingDeclinedProps) {
  return (
    <EmailLayout
      preview={`Your booking of the ${vehicleTitle} didn't go ahead. Your card hasn't been charged.`}
    >
      <EmailHeading>{requestOutcomeHeadings[outcome]}</EmailHeading>
      <EmailText>
        Kia ora {firstName},{' '}
        {outcome === 'DECLINED'
          ? `the host can't take your booking of the ${vehicleTitle} from ${start}.`
          : outcome === 'EXPIRED'
            ? `the host didn't answer your request for the ${vehicleTitle} from ${start} in time.`
            : outcome === 'VERIFICATION_REJECTED'
              ? `we weren't able to verify your identity or driver licence, so your booking of the ${vehicleTitle} from ${start} can't go ahead. Reply to this email if you think we've got it wrong.`
              : `we couldn't finish checking your ID and licence within 24 hours, so your booking of the ${vehicleTitle} from ${start} has expired. You're welcome to book again once the check is done.`}{' '}
        Your card hasn't been charged, and the authorisation has been released (your bank may take a few days
        to show it).
      </EmailText>
      <EmailButton href={searchUrl}>Find another car</EmailButton>
    </EmailLayout>
  );
}

export interface RequestExpiredHostProps {
  firstName: string;
  guestFirstName: string;
  vehicleTitle: string;
  url: string;
  /** The Guest's identity check wasn't approved in time; nothing the Host did or didn't do. */
  guestNotVerified?: boolean;
}

export function RequestExpiredHostEmail({
  firstName,
  guestFirstName,
  vehicleTitle,
  url,
  guestNotVerified = false,
}: RequestExpiredHostProps) {
  return (
    <EmailLayout preview={`${guestFirstName}'s request for your ${vehicleTitle} expired.`}>
      <EmailHeading>A booking request expired</EmailHeading>
      <EmailText>
        Kia ora {firstName},{' '}
        {guestNotVerified
          ? `${guestFirstName}'s request to book your ${vehicleTitle} didn't go ahead because we couldn't verify them in time, so the dates are free again. It doesn't count against your response rate.`
          : `${guestFirstName}'s request to book your ${vehicleTitle} expired after 24 hours without an answer, so the dates are free again. Answering quickly keeps your response rate high.`}
      </EmailText>
      <EmailButton href={url}>Review your bookings</EmailButton>
    </EmailLayout>
  );
}

export interface BookingCancelledProps extends TripBasics {
  audience: 'GUEST' | 'HOST';
  cancelledBy: 'GUEST' | 'HOST' | 'SUPPORT';
  /** Guest: what's refunded. */
  refund?: string;
  /** Guest: what's kept under the cancellation policy. */
  fee?: string;
  /** Host: their share of a kept fee. */
  hostShare?: string;
  /** Host: a Host cancellation fee taken from their next payout. */
  hostFee?: string;
  /** A request withdrawn before the Host answered: nothing was booked or charged. */
  withdrawn?: boolean;
  /** Guest: support cancelled a request, or a booking waiting for verification: the card's hold is released. */
  released?: boolean;
}

export function BookingCancelledEmail(props: BookingCancelledProps) {
  const who =
    props.cancelledBy === 'SUPPORT'
      ? 'our support team'
      : props.cancelledBy === props.audience
        ? 'you'
        : props.audience === 'GUEST'
          ? 'your host'
          : 'the guest';
  if (props.withdrawn) {
    return (
      <EmailLayout preview={`The request to book the ${props.vehicleTitle} (${props.ref}) is withdrawn.`}>
        <EmailHeading>Request withdrawn</EmailHeading>
        <EmailText>
          Kia ora {props.firstName}, {who} withdrew {props.audience === 'GUEST' ? 'your' : 'the'} request to
          book {props.audience === 'GUEST' ? 'the' : 'your'} {props.vehicleTitle} ({props.ref}).
        </EmailText>
        <EmailDetails rows={tripRows(props)} />
        {props.audience === 'GUEST' ? (
          <EmailText>
            You haven't been charged. The amount held on your card is released, and your bank usually shows it
            within a few days.
          </EmailText>
        ) : (
          <EmailText>The dates are free again on your calendar.</EmailText>
        )}
        <EmailButton href={props.url}>View the request</EmailButton>
      </EmailLayout>
    );
  }
  return (
    <EmailLayout preview={`Booking ${props.ref} for the ${props.vehicleTitle} is cancelled.`}>
      <EmailHeading>Booking cancelled</EmailHeading>
      <EmailText>
        Kia ora {props.firstName}, {who} cancelled booking {props.ref} for the {props.vehicleTitle}.
      </EmailText>
      <EmailDetails
        rows={[
          ...tripRows(props),
          ...(props.refund ? [{ label: 'Refund', value: props.refund }] : []),
          ...(props.fee ? [{ label: 'Cancellation fee', value: props.fee }] : []),
          ...(props.hostShare ? [{ label: 'Your share of the fee', value: props.hostShare }] : []),
          ...(props.hostFee ? [{ label: 'Host cancellation fee', value: props.hostFee }] : []),
        ]}
      />
      {props.audience === 'GUEST' && props.refund && (
        <EmailText>
          {/* A Host cancellation always refunds the Guest in full (plan §7, §8.1 item 10). */}
          {props.cancelledBy === 'HOST' ? `You get a full refund of ${props.refund}. ` : ''}
          Refunds go back to the card you paid with and usually show within 5–10 working days.
        </EmailText>
      )}
      {props.audience === 'GUEST' && props.released && (
        <EmailText>
          You haven't been charged. The amount held on your card is released, and your bank usually shows it
          within a few days.
        </EmailText>
      )}
      {props.audience === 'HOST' && <EmailText>The dates are free again on your calendar.</EmailText>}
      <EmailButton href={props.url}>View the booking</EmailButton>
    </EmailLayout>
  );
}

export interface PaymentReceiptProps extends TripBasics {
  paidAt: string;
  method: string;
  lines: EmailPriceLine[];
  total: string;
  gst: string;
  legalName: string;
  /** Shown once the business is GST-registered (plan §16, item 7). */
  gstNumber?: string;
}

export function PaymentReceiptEmail(props: PaymentReceiptProps) {
  return (
    <EmailLayout preview={`Receipt for booking ${props.ref}: ${props.total} NZD.`}>
      <EmailHeading>{props.gstNumber ? 'Tax invoice and receipt' : 'Your receipt'}</EmailHeading>
      <EmailText>
        Thanks, {props.firstName}. We've received your payment for the {props.vehicleTitle}.
      </EmailText>
      <EmailDetails
        rows={[...tripRows(props), { label: 'Paid', value: `${props.paidAt} by ${props.method}` }]}
      />
      <EmailPriceTable lines={props.lines} total={props.total} gst={props.gst} />
      <EmailNote>
        {props.legalName}
        {props.gstNumber ? ` · GST number ${props.gstNumber}` : ''}. All amounts are in New Zealand dollars
        and include GST. If your card is in another currency, your card issuer converts the charge.
      </EmailNote>
      <EmailButton href={props.url}>View your trip</EmailButton>
    </EmailLayout>
  );
}

export interface PaymentFailedProps {
  firstName: string;
  vehicleTitle: string;
  reason?: string;
  retryUrl: string;
  /** When the dates stop being held. */
  holdUntil: string;
}

export function PaymentFailedEmail({
  firstName,
  vehicleTitle,
  reason,
  retryUrl,
  holdUntil,
}: PaymentFailedProps) {
  return (
    <EmailLayout
      preview={`Your payment for the ${vehicleTitle} didn't go through. Try again before ${holdUntil}.`}
    >
      <EmailHeading>Your payment didn't go through</EmailHeading>
      <EmailText>
        Kia ora {firstName}, we couldn't take the payment for the {vehicleTitle}
        {reason ? `: ${reason}` : '.'} We're holding your dates until {holdUntil}, so you can try again or use
        another card.
      </EmailText>
      <EmailButton href={retryUrl}>Try again</EmailButton>
    </EmailLayout>
  );
}

export interface RefundIssuedProps {
  firstName: string;
  ref: string;
  vehicleTitle: string;
  amount: string;
  url: string;
  /** The payment went through after the booking had ended, so it's all given back. */
  afterBookingEnded?: boolean;
}

export function RefundIssuedEmail({
  firstName,
  ref,
  vehicleTitle,
  amount,
  url,
  afterBookingEnded,
}: RefundIssuedProps) {
  return (
    <EmailLayout preview={`We've refunded ${amount} for booking ${ref}.`}>
      <EmailHeading>Refund on its way</EmailHeading>
      {afterBookingEnded ? (
        <EmailText>
          Kia ora {firstName}, your payment for booking {ref} ({vehicleTitle}) went through after the booking
          had ended, so nothing was booked. We've refunded all {amount} NZD to the card you paid with. It
          usually shows within 5–10 working days, depending on your bank.
        </EmailText>
      ) : (
        <EmailText>
          Kia ora {firstName}, we've refunded {amount} NZD for booking {ref} ({vehicleTitle}) to the card you
          paid with. It usually shows within 5–10 working days, depending on your bank.
        </EmailText>
      )}
      <EmailButton href={url}>View the booking</EmailButton>
    </EmailLayout>
  );
}
