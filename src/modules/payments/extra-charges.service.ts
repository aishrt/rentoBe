import mongoose, { type ClientSession, type Types } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { CHARGE_CURRENCY, stripe } from '../../integrations/stripe.js';
import { JobModel } from '../../jobs/job.model.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { formatNzdExact } from '../../lib/format.js';
import { recordAudit } from '../audit/audit.service.js';
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
  /** Adds the charge only if no charge on the booking has this key yet (409 ALREADY_CHARGED otherwise). */
  idempotencyKey?: string;
  /**
   * With `incidentId`: adds the charge only while the case's charges (cancelled ones aside) stay within this,
   * checked in the same write so two staff charging at once can't pass it together (409 OVER_CAP otherwise).
   */
  capCents?: number;
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
  const key = charge.idempotencyKey;
  const capped = charge.capCents !== undefined && charge.incidentId !== undefined;
  const updated = await BookingModel.updateOne(
    {
      _id: bookingId,
      ...(key && { 'extraCharges.idempotencyKey': mongoose.trusted({ $ne: key }) }),
      ...(capped && {
        $expr: mongoose.trusted({
          $lte: [
            {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$extraCharges',
                      as: 'other',
                      cond: {
                        $and: [
                          {
                            $eq: [
                              '$$other.incidentId',
                              new mongoose.Types.ObjectId(String(charge.incidentId)),
                            ],
                          },
                          { $ne: ['$$other.status', 'CANCELLED'] },
                        ],
                      },
                    },
                  },
                  as: 'other',
                  in: '$$other.amountCents',
                },
              },
            },
            charge.capCents! - charge.amountCents,
          ],
        }),
      }),
    },
    {
      $push: {
        extraCharges: {
          _id: chargeId,
          type: charge.type,
          description: charge.description,
          amountCents: charge.amountCents,
          ...(charge.incidentId && { incidentId: charge.incidentId }),
          ...(charge.addedBy && { addedBy: charge.addedBy }),
          ...(key && { idempotencyKey: key }),
          status: 'PENDING',
        },
      },
    },
    { session },
  );
  if (updated.matchedCount === 0) {
    const current = await BookingModel.findById(bookingId)
      .select('extraCharges.idempotencyKey')
      .session(session ?? null)
      .lean();
    if (!current) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that booking.");
    if (key && current.extraCharges.some((other) => other.idempotencyKey === key)) {
      throw new HttpError(409, 'ALREADY_CHARGED', 'This charge has already been added.');
    }
    throw new HttpError(409, 'OVER_CAP', 'This charge would take the case over what it can charge.');
  }
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

/**
 * Marks a paid extra charge, pays the Host their share and sends the Guest a receipt. A charge refunded since
 * (a delayed webhook, or the pay link's sync) stays as the refund left it (plan §8.1, item 15).
 */
async function chargeSucceeded(payment: PaymentDocument, session: ClientSession, now = new Date()) {
  if (payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') return;
  // Taken for a charge staff cancelled meanwhile (its collection was running as they cancelled it): it's
  // recorded as paid, given back in full by `payment.refundUnwanted`, and staff are told (plan §8.1, item 11).
  const cancelled =
    payment.status === 'CANCELLED' ||
    Boolean(
      await BookingModel.exists({
        _id: payment.bookingId,
        extraCharges: mongoose.trusted({ $elemMatch: { _id: payment.extraChargeId, status: 'CANCELLED' } }),
      }).session(session),
    );
  if (payment.status !== 'SUCCEEDED') {
    payment.status = 'SUCCEEDED';
    payment.failureReason = undefined;
    await payment.save({ session });
  }
  if (cancelled) {
    await enqueue(
      'payment.refundUnwanted',
      { paymentId: payment.id, reason: 'CHARGE_CANCELLED' },
      { uniqueKey: `refund-unwanted:${payment.id}`, refId: payment.bookingId.toString(), session },
    );
    const ref = (await BookingModel.findById(payment.bookingId).select('ref').session(session).lean())?.ref;
    await alertStaff(
      {
        type: 'EXTRA_CHARGE_TAKEN_AFTER_CANCEL',
        title: `A cancelled charge on ${ref ?? 'a booking'} was paid`,
        body: `the ${formatNzdExact(payment.amountCents)} extra charge on booking ${ref ?? payment.bookingId.toString()} went through as it was being cancelled. It's being refunded in full automatically; check it in Stripe if that doesn't go through.`,
        link: ref ? `/admin/bookings/${ref}` : '/admin/payments',
        dedupeKey: `EXTRA_CHARGE_TAKEN_AFTER_CANCEL:${payment.id}`,
      },
      { session },
    );
    return;
  }
  const booking = await BookingModel.findOneAndUpdate(
    {
      _id: payment.bookingId,
      extraCharges: mongoose.trusted({
        $elemMatch: { _id: payment.extraChargeId, status: { $ne: 'CANCELLED' } },
      }),
    },
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

  const { payment, cancelledNow } = await withTransaction(async (session) => {
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
    // Staff may have cancelled the charge while it was being collected: checked again here.
    const cancelledNow = Boolean(
      await BookingModel.exists({
        _id: booking._id,
        extraCharges: mongoose.trusted({ $elemMatch: { _id: charge._id, status: 'CANCELLED' } }),
      }).session(session),
    );
    if (intent.status === 'succeeded') {
      // A cancelled charge's payment is given back (chargeSucceeded).
      await chargeSucceeded(record, session, now);
    } else if (cancelledNow) {
      record.status = 'CANCELLED';
      await record.save({ session });
    } else if (failure) {
      record.status = 'FAILED';
      record.failureReason = failure.slice(0, 300);
      await record.save({ session });
    }
    return { payment: record, cancelledNow };
  });

  if (intent.status === 'succeeded') return 'paid';
  if (cancelledNow) {
    // Nothing more to collect: its PaymentIntent stops too, so the pay link can't take it.
    await stopIntent(intent.id).catch(() => undefined);
    return 'skipped';
  }
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

const PAID_STATUSES: PaymentDocument['status'][] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/**
 * Where a pay link's charge stands: DUE until paid; PAID (with refundedCents once part of it is given back);
 * REFUNDED once all of it is; CANCELLED when staff took it off (plan §8.1, items 6 and 11).
 */
function payLinkStatus(payment: PaymentDocument, charge: ExtraChargeRecord | undefined) {
  if (charge?.status === 'CANCELLED' || payment.status === 'CANCELLED') return 'CANCELLED' as const;
  if (payment.status === 'REFUNDED') return 'REFUNDED' as const;
  return PAID_STATUSES.includes(payment.status) ? ('PAID' as const) : ('DUE' as const);
}

type ExtraChargeRecord = NonNullable<Booking['extraCharges'][number]>;

/** GET /payments/{id}: an extra charge for the Guest's pay link. */
export async function payLinkView(guestId: string, paymentId: string) {
  const { payment, booking } = await findGuestPayment(guestId, paymentId);
  const charge = booking.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  const refundedCents = payment.refunds
    .filter((refund) => refund.status !== 'FAILED')
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  return {
    id: payment.id as string,
    bookingRef: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    description: charge?.description ?? 'Extra charge',
    type: charge?.type ?? 'OTHER',
    amountCents: payment.amountCents,
    status: payLinkStatus(payment, charge),
    ...(refundedCents > 0 && { refundedCents }),
    ...(payment.failureReason && { failureReason: payment.failureReason }),
  };
}

/** POST /payments/{id}/pay: what Stripe.js needs to pay the charge with another card, Apple Pay or Google Pay. */
export async function startPayLink(guestId: string, paymentId: string) {
  const { payment, booking } = await findGuestPayment(guestId, paymentId);
  const charge = booking.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  const status = payLinkStatus(payment, charge);
  if (status === 'PAID' || status === 'REFUNDED')
    throw new HttpError(409, 'ALREADY_PAID', 'This charge is already paid.');
  if (status === 'CANCELLED')
    throw new HttpError(409, 'CHARGE_CANCELLED', 'This charge was cancelled, so there’s nothing to pay.');
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

/** Stops a charge's PaymentIntent. One Stripe won't cancel (already paid, say) is returned as it stands. */
async function stopIntent(intentId: string): Promise<Stripe.PaymentIntent> {
  const client = stripe();
  try {
    return await client.paymentIntents.cancel(intentId, {}, { idempotencyKey: `cancel-${intentId}` });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      return client.paymentIntents.retrieve(intentId);
    }
    throw error;
  }
}

/**
 * POST /admin/bookings/{id}/extra-charges/{chargeId}/cancel: staff with the refunds permission cancel a charge
 * that hasn't been paid, a mistake or one written off after its retries (plan §8.1, items 6 and 11). Its
 * PaymentIntent and retries stop, it's no longer owed (so it no longer stops the Guest closing their account),
 * its pay link says it was cancelled, the Guest is told and the audit log records why.
 */
export async function cancelExtraCharge(
  staffId: string,
  bookingId: Id | string,
  chargeId: string,
  reason: string,
  ip?: string,
  now = new Date(),
): Promise<void> {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  const charge = mongoose.isValidObjectId(chargeId)
    ? booking?.extraCharges.find((candidate) => candidate._id?.equals(chargeId))
    : undefined;
  if (!booking || !charge) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that charge.");
  if (charge.status !== 'PENDING' && charge.status !== 'FAILED') {
    throw new HttpError(
      409,
      'NOT_CANCELLABLE',
      charge.status === 'CANCELLED'
        ? 'This charge is already cancelled.'
        : 'This charge has been paid, so it can’t be cancelled. Refund it instead.',
    );
  }
  const payment = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'EXTRA_CHARGE',
    extraChargeId: charge._id,
  }).sort({ createdAt: -1 });
  if (payment) {
    const intent = await stopIntent(payment.stripePaymentIntentId);
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      // The Guest paid it a moment ago: it's recorded as paid, and can be refunded instead.
      if (intent.status === 'succeeded') {
        await withTransaction((session) => applyExtraChargeIntent(intent, session));
      }
      throw new HttpError(
        409,
        'ALREADY_PAID',
        'The guest has just paid this charge, so it can’t be cancelled. Refund it instead.',
      );
    }
  }

  const cancelled = await withTransaction(async (session) => {
    const updated = await BookingModel.updateOne(
      {
        _id: booking._id,
        extraCharges: mongoose.trusted({
          $elemMatch: { _id: charge._id, status: { $in: ['PENDING', 'FAILED'] } },
        }),
      },
      { $set: { 'extraCharges.$.status': 'CANCELLED' } },
      { session },
    );
    if (updated.modifiedCount === 0) return false;
    if (payment) {
      await PaymentModel.updateOne(
        { _id: payment._id, status: mongoose.trusted({ $in: ['PENDING', 'FAILED'] }) },
        { $set: { status: 'CANCELLED' } },
        { session },
      );
    }
    // Its retries on the saved card stop.
    await JobModel.updateMany(
      { type: 'extraCharge.collect', status: 'QUEUED', 'payload.chargeId': charge._id!.toString() },
      { $set: { status: 'CANCELLED', finishedAt: now } },
      { session },
    );
    const guest = await UserModel.findById(booking.guestId).select('firstName').session(session).lean();
    const amount = formatNzdExact(charge.amountCents);
    await notify(
      {
        userId: booking.guestId,
        type: 'EXTRA_CHARGE_CANCELLED',
        title: `Charge cancelled for ${booking.ref}`,
        body: `The ${amount} charge (${charge.description}) is cancelled. There’s nothing to pay.`,
        link: `/trips/${booking.ref}`,
        email: {
          template: 'tripNotice',
          props: {
            firstName: guest?.firstName ?? 'there',
            heading: 'A charge for your trip is cancelled',
            paragraphs: [
              `We’ve cancelled the ${amount} charge for your trip in the ${booking.vehicleSnapshot.title}: ${charge.description}.`,
              'There’s nothing to pay, and the payment link we sent you for it no longer takes payments.',
            ],
            rows: [
              { label: 'Booking', value: booking.ref },
              { label: 'Charge', value: charge.description },
              { label: 'Amount', value: amount },
            ],
            buttonLabel: 'View your trip',
            url: `${siteUrl()}/trips/${booking.ref}`,
          },
        },
        dedupeKey: `EXTRA_CHARGE_CANCELLED:${charge._id!.toString()}`,
      },
      { session },
    );
    return true;
  });
  if (!cancelled)
    throw new HttpError(409, 'ALREADY_CHANGED', 'This charge has just changed. Please refresh.');

  await recordAudit({
    actorId: staffId,
    action: 'booking.extra-charge-cancelled',
    entity: 'booking',
    entityId: booking._id.toString(),
    before: { chargeId: charge._id!.toString(), status: charge.status, amountCents: charge.amountCents },
    after: { status: 'CANCELLED', reason },
    ...(ip && { ip }),
  });
}

/**
 * `payment.refundUnwanted` for a charge cancelled while it was being collected (CHARGE_CANCELLED): what Stripe
 * took is refunded in full, funded by the platform, and the Guest is told (plan §8.1, item 11). Resolves whether
 * a refund was made.
 */
export async function refundCancelledCharge(paymentId: string): Promise<boolean> {
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.type !== 'EXTRA_CHARGE') return false;
  if (payment.refunds.some((refund) => refund.status !== 'FAILED')) return false;
  const booking = await BookingModel.findById(payment.bookingId).lean<BookingRecord>();
  const charge = booking?.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  if (!booking || charge?.status !== 'CANCELLED') return false;
  const client = stripe();
  const intent = await client.paymentIntents.retrieve(payment.stripePaymentIntentId);
  if (intent.status !== 'succeeded') return false;
  const refund = await client.refunds.create(
    {
      payment_intent: payment.stripePaymentIntentId,
      amount: payment.amountCents,
      reason: 'requested_by_customer',
      metadata: { bookingId: booking._id.toString() },
    },
    { idempotencyKey: `refund-${payment.id}-charge-cancelled` },
  );
  const status =
    refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'failed' ? 'FAILED' : 'PENDING';
  await withTransaction(async (session) => {
    const fresh = await PaymentModel.findById(payment._id).session(session);
    if (!fresh || fresh.refunds.some((item) => item.stripeRefundId === refund.id)) return;
    fresh.refunds.push({
      amountCents: refund.amount,
      reason: 'Charge cancelled',
      kind: 'STAFF',
      fundedBy: 'PLATFORM',
      stripeRefundId: refund.id,
      status,
      ...(refund.failure_reason && { failureReason: refund.failure_reason }),
      createdAt: new Date(),
    });
    fresh.status = status === 'FAILED' ? 'SUCCEEDED' : 'REFUNDED';
    await fresh.save({ session });
    if (status === 'FAILED') {
      await alertStaff(
        {
          type: 'REFUND_FAILED',
          title: 'A refund failed',
          body: `the refund of a cancelled ${formatNzdExact(refund.amount)} charge on booking ${booking.ref} failed (${refund.failure_reason ?? 'unknown'}). Please return the money to the guest another way.`,
          link: `/admin/bookings/${booking.ref}`,
          dedupeKey: `REFUND_FAILED:${refund.id}`,
        },
        { session },
      );
      return;
    }
    await notify(
      {
        userId: booking.guestId,
        type: 'REFUND_ISSUED',
        title: `${formatNzdExact(refund.amount)} refunded`,
        body: `The charge for ${charge.description} on ${booking.ref} was cancelled, so its payment is refunded.`,
        link: `/trips/${booking.ref}`,
        dedupeKey: `REFUND_ISSUED:${payment.id}:charge-cancelled`,
      },
      { session },
    );
  });
  return true;
}
