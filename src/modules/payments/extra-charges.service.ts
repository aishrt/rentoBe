import mongoose, { type ClientSession, type Types } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { CHARGE_CURRENCY, stripe } from '../../integrations/stripe.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { formatNzdExact } from '../../lib/format.js';
import { BookingModel, type Booking, type ExtraChargeType } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { scheduleExtraChargePayout } from '../payouts/payouts.service.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { UserModel } from '../users/user.model.js';
import { PaymentModel, type PaymentDocument } from './payment.model.js';
import { ensureCustomer } from './stripe-customer.js';

/*
 * Charges after the trip (plan §8.1, items 6 and 11; §4.3 `trip.extraCharges`): extra kilometres worked out
 * from the condition reports, and fuel, cleaning, late return, damage, tolls or fines added by support from
 * a resolved incident. Each is charged to the card the Guest saved at checkout. If that fails, the Guest gets
 * a link to pay, it's tried again and support is alerted. The Host's share is paid as its own payout.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tries before the charge is left to the pay link and support. */
const MAX_ATTEMPTS = 3;

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
export const payLinkPath = (paymentId: string) => `/pay/${paymentId}`;

export interface NewExtraCharge {
  type: ExtraChargeType;
  description: string;
  amountCents: number;
  incidentId?: Id | string;
  addedBy?: Id | string;
}

/** Adds a charge to the booking and queues collecting it. Resolves with the charge's id. */
export async function addExtraCharge(
  bookingId: Id | string,
  charge: NewExtraCharge,
  session?: ClientSession,
): Promise<string> {
  if (!Number.isInteger(charge.amountCents) || charge.amountCents <= 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      amountCents: 'Enter an amount',
    });
  }
  const chargeId = new mongoose.Types.ObjectId();
  const updated = await BookingModel.updateOne(
    { _id: bookingId },
    {
      $push: {
        extraCharges: {
          _id: chargeId,
          type: charge.type,
          description: charge.description,
          amountCents: charge.amountCents,
          ...(charge.incidentId && { incidentId: charge.incidentId }),
          ...(charge.addedBy && { addedBy: charge.addedBy }),
          status: 'PENDING',
        },
      },
    },
    { session },
  );
  if (updated.matchedCount === 0) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that booking.");
  await enqueue(
    'extraCharge.collect',
    { bookingId: String(bookingId), chargeId: chargeId.toString(), attempt: 1 },
    { uniqueKey: `extra-charge:${chargeId.toString()}:1`, refId: String(bookingId), session },
  );
  return chargeId.toString();
}

/** The card the Guest paid for the booking with, saved for charges like this (plan §8.1, item 3). */
async function savedCard(booking: BookingRecord): Promise<string | undefined> {
  const payment = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'BOOKING',
    status: mongoose.trusted({ $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }),
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!payment) return undefined;
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
  const method = intent.payment_method;
  return typeof method === 'string' ? method : method?.id;
}

/** Marks a paid extra charge, pays the Host their share and sends the Guest a receipt. */
async function chargeSucceeded(payment: PaymentDocument, session: ClientSession, now = new Date()) {
  if (payment.status !== 'SUCCEEDED') {
    payment.status = 'SUCCEEDED';
    payment.failureReason = undefined;
    await payment.save({ session });
  }
  const booking = await BookingModel.findOneAndUpdate(
    { _id: payment.bookingId, 'extraCharges._id': payment.extraChargeId },
    { $set: { 'extraCharges.$.status': 'SUCCEEDED', 'extraCharges.$.paymentId': payment._id } },
    { new: true, session },
  ).lean<BookingRecord>();
  const charge = booking?.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  if (!booking || !charge) return;
  await scheduleExtraChargePayout(
    booking,
    { _id: charge._id!, amountCents: charge.amountCents },
    session,
    now,
  );
  const guest = await UserModel.findById(booking.guestId).select('firstName').session(session).lean();
  await notify(
    {
      userId: booking.guestId,
      type: 'EXTRA_CHARGE_PAID',
      title: `${formatNzdExact(charge.amountCents)} charged for ${booking.ref}`,
      body: charge.description,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'tripNotice',
        props: {
          firstName: guest?.firstName ?? 'there',
          heading: `Receipt: ${formatNzdExact(charge.amountCents)} for your trip`,
          paragraphs: [
            `We've charged ${formatNzdExact(charge.amountCents)} to your saved card for your trip in the ${booking.vehicleSnapshot.title}: ${charge.description}.`,
            'It includes GST. If you think it’s wrong, reply to this email or contact support.',
          ],
          rows: [
            { label: 'Booking', value: booking.ref },
            { label: 'Charge', value: charge.description },
            { label: 'Amount (incl. GST)', value: formatNzdExact(charge.amountCents) },
          ],
          buttonLabel: 'View your trip',
          url: `${siteUrl()}/trips/${booking.ref}`,
        },
      },
      dedupeKey: `EXTRA_CHARGE_PAID:${payment.id}`,
    },
    { session },
  );
}

/** A charge that didn't go through: the Guest gets the pay link, and support hears on the last try. */
async function chargeFailed(
  booking: BookingRecord,
  charge: NonNullable<Booking['extraCharges'][number]>,
  payment: PaymentDocument,
  reason: string,
  attempt: number,
) {
  const guest = await UserModel.findById(booking.guestId).select('firstName').lean();
  const path = payLinkPath(payment.id);
  await notify({
    userId: booking.guestId,
    type: 'EXTRA_CHARGE_FAILED',
    title: `Please pay ${formatNzdExact(charge.amountCents)} for ${booking.ref}`,
    body: `${charge.description}. Your saved card was declined.`,
    link: path,
    email: {
      template: 'tripNotice',
      props: {
        firstName: guest?.firstName ?? 'there',
        heading: 'A charge for your trip didn’t go through',
        paragraphs: [
          `We tried to charge ${formatNzdExact(charge.amountCents)} to your saved card for your trip in the ${booking.vehicleSnapshot.title} (${charge.description}), but it didn’t go through: ${reason}`,
          'Please pay it with the link below. We’ll try your saved card again in a day.',
        ],
        rows: [
          { label: 'Booking', value: booking.ref },
          { label: 'Amount (incl. GST)', value: formatNzdExact(charge.amountCents) },
        ],
        buttonLabel: 'Pay now',
        url: `${siteUrl()}${path}`,
      },
    },
    dedupeKey: `EXTRA_CHARGE_FAILED:${payment.id}`,
  });
  if (attempt >= MAX_ATTEMPTS - 1) {
    await alertStaff({
      type: 'EXTRA_CHARGE_FAILED',
      title: `An extra charge on ${booking.ref} keeps failing`,
      body: `the ${formatNzdExact(charge.amountCents)} charge (${charge.description}) on booking ${booking.ref} has failed ${attempt} times: ${reason}. The guest has a link to pay it.`,
      link: `/admin/bookings/${booking.ref}`,
      dedupeKey: `EXTRA_CHARGE_FAILED:${charge._id!.toString()}`,
    });
  }
}

/**
 * `extraCharge.collect`: charges one extra charge to the saved card, off-session. A decline keeps the
 * PaymentIntent for the pay link and tries again tomorrow, up to 3 times.
 */
export async function collectExtraCharge(
  bookingId: string,
  chargeId: string,
  attempt: number,
  now = new Date(),
): Promise<'paid' | 'failed' | 'skipped'> {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  const charge = booking?.extraCharges.find((candidate) => candidate._id?.equals(chargeId));
  if (!booking || !charge || charge.status !== 'PENDING') return 'skipped';
  const existing = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'EXTRA_CHARGE',
    extraChargeId: charge._id,
  }).sort({ createdAt: -1 });
  if (existing?.status === 'SUCCEEDED') return 'skipped';

  const client = stripe();
  const customer = await ensureCustomer(booking.guestId.toString());
  const method = await savedCard(booking);
  const metadata = {
    purpose: 'extra_charge',
    bookingId: booking._id.toString(),
    bookingRef: booking.ref,
    extraChargeId: chargeId,
  };
  const description = `Rento Vroom ${booking.ref}: ${charge.description}`;
  let intent: Stripe.PaymentIntent;
  let failure: string | undefined;
  try {
    if (!method) throw new HttpError(409, 'NO_SAVED_CARD', 'there’s no saved card for this booking');
    // One PaymentIntent per charge: a retry confirms the same one again, so the pay link and the retries
    // can never both take the money.
    intent = existing
      ? await client.paymentIntents.confirm(
          existing.stripePaymentIntentId,
          { payment_method: method, off_session: true },
          { idempotencyKey: `extra-charge-${chargeId}-${attempt}` },
        )
      : await client.paymentIntents.create(
          {
            amount: charge.amountCents,
            currency: CHARGE_CURRENCY,
            customer,
            payment_method: method,
            off_session: true,
            confirm: true,
            description,
            metadata,
          },
          { idempotencyKey: `extra-charge-${chargeId}-${attempt}` },
        );
  } catch (error) {
    // A decline comes back as an error with the PaymentIntent, which the pay link then completes.
    const declined = error instanceof Stripe.errors.StripeCardError ? error.payment_intent : undefined;
    failure = error instanceof Error ? error.message : 'the card was declined';
    intent =
      declined ??
      (existing
        ? await client.paymentIntents.retrieve(existing.stripePaymentIntentId)
        : await client.paymentIntents.create(
            {
              amount: charge.amountCents,
              currency: CHARGE_CURRENCY,
              customer,
              setup_future_usage: 'off_session',
              automatic_payment_methods: { enabled: true },
              description,
              metadata,
            },
            { idempotencyKey: `extra-charge-${chargeId}-link` },
          ));
  }

  const payment = await withTransaction(async (session) => {
    const found = await PaymentModel.findOne({ stripePaymentIntentId: intent.id }).session(session);
    const record =
      found ??
      (
        await PaymentModel.create(
          [
            {
              bookingId: booking._id,
              type: 'EXTRA_CHARGE',
              extraChargeId: charge._id,
              stripePaymentIntentId: intent.id,
              amountCents: charge.amountCents,
              status: 'PENDING',
            },
          ],
          { session },
        )
      )[0]!;
    await BookingModel.updateOne(
      { _id: booking._id, 'extraCharges._id': charge._id },
      { $set: { 'extraCharges.$.paymentId': record._id } },
      { session },
    );
    if (intent.status === 'succeeded') {
      await chargeSucceeded(record, session, now);
    } else if (failure) {
      record.status = 'FAILED';
      record.failureReason = failure.slice(0, 300);
      await record.save({ session });
    }
    return record;
  });

  if (intent.status === 'succeeded') return 'paid';
  await chargeFailed(booking, charge, payment, failure ?? 'it needs your confirmation', attempt);
  if (attempt < MAX_ATTEMPTS) {
    await enqueue(
      'extraCharge.collect',
      { bookingId, chargeId, attempt: attempt + 1 },
      {
        runAt: new Date(now.getTime() + DAY_MS),
        uniqueKey: `extra-charge:${chargeId}:${attempt + 1}`,
        refId: bookingId,
      },
    );
  }
  return 'failed';
}

/**
 * Applies an extra charge's PaymentIntent from a webhook or the pay link's sync, inside the caller's
 * transaction. Safe to run any number of times.
 */
export async function applyExtraChargeIntent(
  intent: Pick<Stripe.PaymentIntent, 'id' | 'status' | 'last_payment_error'>,
  session: ClientSession,
): Promise<void> {
  const payment = await PaymentModel.findOne({ stripePaymentIntentId: intent.id }).session(session);
  if (!payment || payment.type !== 'EXTRA_CHARGE') return;
  if (intent.status === 'succeeded') {
    await chargeSucceeded(payment, session);
  } else if (intent.status === 'requires_payment_method' && intent.last_payment_error?.message) {
    if (payment.status === 'PENDING') {
      payment.status = 'FAILED';
      payment.failureReason = intent.last_payment_error.message.slice(0, 300);
      await payment.save({ session });
    }
  }
}

async function findGuestPayment(guestId: string, paymentId: string) {
  if (!mongoose.isValidObjectId(paymentId))
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that payment.");
  const payment = await PaymentModel.findById(paymentId);
  const booking = payment ? await BookingModel.findById(payment.bookingId).lean<BookingRecord>() : null;
  if (!payment || !booking || !booking.guestId.equals(guestId) || payment.type !== 'EXTRA_CHARGE') {
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that payment.");
  }
  return { payment, booking };
}

/** GET /payments/{id}: an extra charge for the Guest's pay link. */
export async function payLinkView(guestId: string, paymentId: string) {
  const { payment, booking } = await findGuestPayment(guestId, paymentId);
  const charge = booking.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  return {
    id: payment.id as string,
    bookingRef: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    description: charge?.description ?? 'Extra charge',
    type: charge?.type ?? 'OTHER',
    amountCents: payment.amountCents,
    status: payment.status === 'SUCCEEDED' ? ('PAID' as const) : ('DUE' as const),
    ...(payment.failureReason && { failureReason: payment.failureReason }),
  };
}

/** POST /payments/{id}/pay: what Stripe.js needs to pay the charge with another card, Apple Pay or Google Pay. */
export async function startPayLink(guestId: string, paymentId: string) {
  const { payment } = await findGuestPayment(guestId, paymentId);
  if (payment.status === 'SUCCEEDED')
    throw new HttpError(409, 'ALREADY_PAID', 'This charge is already paid.');
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) {
    throw new HttpError(409, 'NOT_PAYABLE', 'This charge can’t be paid here. Please contact support.');
  }
  return { clientSecret: intent.client_secret!, amountCents: intent.amount, currency: CHARGE_CURRENCY };
}

/** POST /payments/{id}/sync: after Stripe.js confirms, apply the result straight away. */
export async function syncPayLink(guestId: string, paymentId: string) {
  const { payment } = await findGuestPayment(guestId, paymentId);
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
  await withTransaction((session) => applyExtraChargeIntent(intent, session));
  return payLinkView(guestId, paymentId);
}
