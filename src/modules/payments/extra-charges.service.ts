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
import { recordCaseChargeChange } from '../incidents/incidents.service.js';
import { notify } from '../notifications/notify.js';
import { scheduleExtraChargePayout } from '../payouts/payouts.service.js';
import { checkFailedPayments } from '../risk/risk-signals.js';
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
  /** With `capCents`: only the case's charges of these types count towards it (all of them without). */
  capTypes?: readonly ExtraChargeType[];
}

/**
 * Adds a charge to the booking and queues collecting it. Resolves with the charge's id. Pass a transaction, so
 * the charge and its collection are saved together (a charge saved without its job would never be collected).
 */
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
                          ...(charge.capTypes ? [{ $in: ['$$other.type', [...charge.capTypes]] }] : []),
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
  const current = await BookingModel.findById(payment.bookingId)
    .select('ref extraCharges._id extraCharges.status extraCharges.paymentId')
    .session(session)
    .lean<BookingRecord>();
  const existing = current?.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  // Taken for a charge staff cancelled meanwhile (its collection was running as they cancelled it): it's
  // recorded as paid, given back in full by `payment.refundUnwanted`, and staff are told (plan §8.1, item 11).
  const cancelled = payment.status === 'CANCELLED' || existing?.status === 'CANCELLED';
  // A second payment for a charge another payment has paid already: given back in full the same way.
  const paidTwice =
    !cancelled &&
    existing?.status === 'SUCCEEDED' &&
    Boolean(existing.paymentId && !existing.paymentId.equals(payment._id));
  if (payment.status !== 'SUCCEEDED') {
    payment.status = 'SUCCEEDED';
    payment.failureReason = undefined;
    await payment.save({ session });
  }
  if (cancelled || paidTwice) {
    await enqueue(
      'payment.refundUnwanted',
      { paymentId: payment.id, reason: cancelled ? 'CHARGE_CANCELLED' : 'CHARGE_DUPLICATE' },
      { uniqueKey: `refund-unwanted:${payment.id}`, refId: payment.bookingId.toString(), session },
    );
    const ref = current?.ref;
    const amount = formatNzdExact(payment.amountCents);
    const booking = ref ?? payment.bookingId.toString();
    await alertStaff(
      cancelled
        ? {
            type: 'EXTRA_CHARGE_TAKEN_AFTER_CANCEL',
            title: `A cancelled charge on ${ref ?? 'a booking'} was paid`,
            body: `the ${amount} extra charge on booking ${booking} went through as it was being cancelled. It's being refunded in full automatically; check it in Stripe if that doesn't go through.`,
            link: ref ? `/admin/bookings/${ref}` : '/admin/payments',
            dedupeKey: `EXTRA_CHARGE_TAKEN_AFTER_CANCEL:${payment.id}`,
          }
        : {
            type: 'EXTRA_CHARGE_PAID_TWICE',
            title: `An extra charge on ${ref ?? 'a booking'} was paid twice`,
            body: `the ${amount} extra charge on booking ${booking} was paid a second time. The second payment is being refunded in full automatically; check it in Stripe if that doesn't go through.`,
            link: ref ? `/admin/bookings/${ref}` : '/admin/payments',
            dedupeKey: `EXTRA_CHARGE_PAID_TWICE:${payment.id}`,
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
 * The charge's PaymentIntent and its payment record, made once per charge: created under a key fixed for the
 * charge (a retry after a timeout, or the job running twice at once, gets the same one back from Stripe) and
 * recorded before anything is charged, so whatever happens to it (a webhook, the pay link) is applied to it.
 * The same PaymentIntent is confirmed with the saved card and, after a decline, paid on the pay link, so the
 * two can never both take the money.
 */
async function chargeIntent(booking: BookingRecord, charge: ExtraChargeRecord): Promise<PaymentDocument> {
  const chargeId = charge._id!.toString();
  const customer = await ensureCustomer(booking.guestId.toString());
  const intent = await stripe().paymentIntents.create(
    {
      amount: charge.amountCents,
      currency: CHARGE_CURRENCY,
      customer,
      // A card the Guest pays with on the pay link is saved for later charges too.
      setup_future_usage: 'off_session',
      automatic_payment_methods: { enabled: true },
      description: `Rento Vroom ${booking.ref}: ${charge.description}`,
      metadata: {
        purpose: 'extra_charge',
        bookingId: booking._id.toString(),
        bookingRef: booking.ref,
        extraChargeId: chargeId,
      },
    },
    { idempotencyKey: `extra-charge-${chargeId}` },
  );
  try {
    const [created] = await PaymentModel.create([
      {
        bookingId: booking._id,
        type: 'EXTRA_CHARGE',
        extraChargeId: charge._id,
        stripePaymentIntentId: intent.id,
        amountCents: charge.amountCents,
        status: 'PENDING',
      },
    ]);
    return created!;
  } catch (error) {
    // Recorded a moment ago by the same job running at the same time.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      const found = await PaymentModel.findOne({ stripePaymentIntentId: intent.id });
      if (found) return found;
    }
    throw error;
  }
}

/**
 * `extraCharge.collect`: charges one extra charge to the saved card, off-session. A decline keeps the
 * PaymentIntent for the pay link and tries again tomorrow, up to 3 times. Any other error (a timeout, Stripe
 * being down) is thrown, so the job runs again with the same idempotency keys and never charges twice.
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
  if (existing && PAID_STATUSES.includes(existing.status)) return 'skipped';
  const payment = existing ?? (await chargeIntent(booking, charge));

  const client = stripe();
  const method = await savedCard(booking);
  let intent: Stripe.PaymentIntent;
  let failure: string | undefined;
  if (!method) {
    failure = 'there’s no saved card for this booking';
    intent = await client.paymentIntents.retrieve(payment.stripePaymentIntentId);
  } else {
    try {
      intent = await client.paymentIntents.confirm(
        payment.stripePaymentIntentId,
        {
          payment_method: method,
          off_session: true,
          return_url: `${siteUrl()}${payLinkPath(payment.id)}`,
        },
        { idempotencyKey: `extra-charge-${chargeId}-confirm-${attempt}` },
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        // A decline: the PaymentIntent waits for the Guest on the pay link.
        failure = error.message || 'the card was declined';
        intent =
          error.payment_intent ?? (await client.paymentIntents.retrieve(payment.stripePaymentIntentId));
      } else {
        // Paid meanwhile on the pay link, or charged although the answer was lost: applied as paid. Anything
        // else is tried again by the job, with the same key.
        const current = await client.paymentIntents
          .retrieve(payment.stripePaymentIntentId)
          .catch(() => undefined);
        if (current?.status !== 'succeeded') throw error;
        intent = current;
      }
    }
  }

  const cancelledNow = await withTransaction(async (session) => {
    const record = (await PaymentModel.findById(payment._id).session(session)) ?? payment;
    await BookingModel.updateOne(
      {
        _id: booking._id,
        extraCharges: mongoose.trusted({
          $elemMatch: { _id: charge._id, status: { $in: ['PENDING', 'FAILED'] } },
        }),
      },
      { $set: { 'extraCharges.$.paymentId': record._id } },
      { session },
    );
    // Staff may have cancelled the charge while it was being collected: checked again here.
    const cancelled = Boolean(
      await BookingModel.exists({
        _id: booking._id,
        extraCharges: mongoose.trusted({ $elemMatch: { _id: charge._id, status: 'CANCELLED' } }),
      }).session(session),
    );
    if (intent.status === 'succeeded') {
      // A cancelled charge's payment is given back (chargeSucceeded).
      await chargeSucceeded(record, session, now);
    } else if (cancelled) {
      if (record.status === 'PENDING' || record.status === 'FAILED') {
        record.status = 'CANCELLED';
        await record.save({ session });
      }
    } else if (failure) {
      record.status = 'FAILED';
      record.failureReason = failure.slice(0, 300);
      await record.save({ session });
      // Too many failed card payments in a day raise a risk flag, as for a booking's payment (plan §14).
      await checkFailedPayments(booking.guestId, session, now);
    }
    return cancelled;
  });

  if (intent.status === 'succeeded') return 'paid';
  if (cancelledNow) {
    // Nothing more to collect: its PaymentIntent stops too, so the pay link can't take it.
    await stopIntent(intent.id).catch(() => undefined);
    return 'skipped';
  }
  // Still with the bank: its webhook says how it ends.
  if (intent.status === 'processing') return 'skipped';
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
    // Too many failed card payments in a day raise a risk flag, as for a booking's payment (plan §14).
    const booking = await BookingModel.findById(payment.bookingId).select('guestId').session(session).lean();
    if (booking) await checkFailedPayments(booking.guestId, session);
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
 * REFUNDED once all of it is; CANCELLED when staff took it off (plan §8.1, items 6 and 11). A charge paid
 * another way (its saved card, say, while this link's payment waited) is PAID too, so the link takes nothing.
 */
function payLinkStatus(payment: PaymentDocument, charge: ExtraChargeRecord | undefined) {
  if (charge?.status === 'CANCELLED' || payment.status === 'CANCELLED') return 'CANCELLED' as const;
  if (payment.status === 'REFUNDED') return 'REFUNDED' as const;
  if (charge?.status === 'SUCCEEDED') return 'PAID' as const;
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
 * its pay link says it was cancelled, the Guest is told, its case (if a case added it) shows it was cancelled
 * and the audit log records why. `corrected`: an extra-kilometre charge worked out again after staff corrected
 * a reading, which the Guest is told instead.
 */
export async function cancelExtraCharge(
  staffId: string,
  bookingId: Id | string,
  chargeId: string,
  reason: string,
  ip?: string,
  now = new Date(),
  { corrected = false }: { corrected?: boolean } = {},
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
    const amount = formatNzdExact(charge.amountCents);
    // The case's history keeps every change to its charges (spec §15).
    if (charge.incidentId) {
      await recordCaseChargeChange(
        charge.incidentId,
        {
          action: 'CHARGE_CANCELLED',
          actorId: staffId,
          extraChargeId: charge._id!,
          note: `The ${amount} charge to the guest was cancelled: ${charge.description}.`,
          now,
        },
        session,
      );
    }
    const guest = await UserModel.findById(booking.guestId).select('firstName').session(session).lean();
    await notify(
      {
        userId: booking.guestId,
        type: 'EXTRA_CHARGE_CANCELLED',
        title: `Charge ${corrected ? 'corrected' : 'cancelled'} for ${booking.ref}`,
        body: corrected
          ? `The ${amount} charge (${charge.description}) is cancelled: it’s worked out again from corrected readings.`
          : `The ${amount} charge (${charge.description}) is cancelled. There’s nothing to pay.`,
        link: `/trips/${booking.ref}`,
        email: {
          template: 'tripNotice',
          props: {
            firstName: guest?.firstName ?? 'there',
            heading: corrected
              ? 'A charge for your trip is being corrected'
              : 'A charge for your trip is cancelled',
            paragraphs: corrected
              ? [
                  `We’ve cancelled the ${amount} charge for your trip in the ${booking.vehicleSnapshot.title} (${charge.description}): our team corrected the odometer readings it was worked out from.`,
                  'If there’s still something to pay, it’s charged to your saved card and you’ll get a receipt. The payment link we sent you for the old charge no longer takes payments.',
                ]
              : [
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

/** Why `payment.refundUnwanted` gives an extra charge's payment back. */
export type UnwantedChargeReason = 'CHARGE_CANCELLED' | 'CHARGE_DUPLICATE';

/**
 * `payment.refundUnwanted` for an extra charge's payment nobody owes: one taken for a charge cancelled while it
 * was being collected (CHARGE_CANCELLED), or a second payment for a charge another one had paid already
 * (CHARGE_DUPLICATE). What Stripe took is refunded in full, funded by the platform, and the Guest is told
 * (plan §8.1, items 11 and 14). Resolves whether a refund was made.
 */
export async function refundUnwantedCharge(
  paymentId: string,
  reason: UnwantedChargeReason = 'CHARGE_CANCELLED',
): Promise<boolean> {
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.type !== 'EXTRA_CHARGE') return false;
  if (payment.refunds.some((refund) => refund.status !== 'FAILED')) return false;
  const booking = await BookingModel.findById(payment.bookingId).lean<BookingRecord>();
  const charge = booking?.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
  if (!booking || !charge) return false;
  const unwanted =
    reason === 'CHARGE_CANCELLED'
      ? charge.status === 'CANCELLED'
      : charge.status === 'SUCCEEDED' &&
        Boolean(charge.paymentId && !charge.paymentId.equals(payment._id));
  if (!unwanted) return false;
  const client = stripe();
  const intent = await client.paymentIntents.retrieve(payment.stripePaymentIntentId);
  if (intent.status !== 'succeeded') return false;
  const key = reason === 'CHARGE_CANCELLED' ? 'charge-cancelled' : 'paid-twice';
  const refund = await client.refunds.create(
    {
      payment_intent: payment.stripePaymentIntentId,
      amount: payment.amountCents,
      reason: reason === 'CHARGE_CANCELLED' ? 'requested_by_customer' : 'duplicate',
      metadata: { bookingId: booking._id.toString() },
    },
    { idempotencyKey: `refund-${payment.id}-${key}` },
  );
  const status =
    refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'failed' ? 'FAILED' : 'PENDING';
  await withTransaction(async (session) => {
    const fresh = await PaymentModel.findById(payment._id).session(session);
    if (!fresh || fresh.refunds.some((item) => item.stripeRefundId === refund.id)) return;
    fresh.refunds.push({
      amountCents: refund.amount,
      reason: reason === 'CHARGE_CANCELLED' ? 'Charge cancelled' : 'Charge paid twice',
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
          body: `the refund of ${reason === 'CHARGE_CANCELLED' ? 'a cancelled' : 'a second payment for a'} ${formatNzdExact(refund.amount)} charge on booking ${booking.ref} failed (${refund.failure_reason ?? 'unknown'}). Please return the money to the guest another way.`,
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
        body:
          reason === 'CHARGE_CANCELLED'
            ? `The charge for ${charge.description} on ${booking.ref} was cancelled, so its payment is refunded.`
            : `The charge for ${charge.description} on ${booking.ref} was paid twice, so the second payment is refunded.`,
        link: `/trips/${booking.ref}`,
        dedupeKey: `REFUND_ISSUED:${payment.id}:${key}`,
      },
      { session },
    );
  });
  return true;
}
