import mongoose, { type ClientSession, type Types } from 'mongoose';
import type Stripe from 'stripe';
import { stripe } from '../../integrations/stripe.js';
import { enqueue } from '../../jobs/queue.js';
import { countryName } from '../../lib/countries.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { notAbandonedCheckout } from '../bookings/made-bookings.js';
import { PaymentModel } from '../payments/payment.model.js';
import { StripeEventModel } from '../payments/stripe-event.model.js';
import { licenceCountryCode } from '../users/driver-licence.service.js';
import { UserModel } from '../users/user.model.js';
import { raiseRiskFlag } from './risk-flags.js';

/*
 * The payment and booking signals behind risk flags (plan §9 Days 20–22, §14): many failed payments in a
 * day, many bookings in a day, a card from another country than the account, and Stripe Radar's warnings.
 * A flag only puts the person in the admins' risk queue; nothing is blocked automatically (that is the
 * later advanced fraud work, roadmap R12).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Radar's risk levels that need a person to look. */
const RADAR_WARNINGS = new Set(['elevated', 'highest']);

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * A failed card payment (plan §8.1, item 6), for a booking or an extra charge after a trip: too many in a day
 * raises FAILED_PAYMENTS.
 */
export async function checkFailedPayments(guestId: Types.ObjectId, session: ClientSession, now = new Date()) {
  const settings = await getPlatformSettings();
  const bookings = await BookingModel.find({
    guestId,
    $or: [
      { createdAt: mongoose.trusted({ $gte: new Date(now.getTime() - 7 * DAY_MS) }) },
      // Extra charges come after the trip, often weeks after it was booked.
      { 'extraCharges.0': mongoose.trusted({ $exists: true }) },
    ],
  })
    .select('_id')
    .session(session)
    .lean();
  const intents = await PaymentModel.find({
    bookingId: mongoose.trusted({ $in: bookings.map((booking) => booking._id) }),
  })
    .select('stripePaymentIntentId')
    .session(session)
    .lean();
  const failures = await StripeEventModel.countDocuments({
    type: 'payment_intent.payment_failed',
    objectId: mongoose.trusted({ $in: intents.map((payment) => payment.stripePaymentIntentId) }),
    processedAt: mongoose.trusted({ $gte: new Date(now.getTime() - DAY_MS) }),
  }).session(session);
  if (failures >= settings.risk.failedPaymentsPerDay) {
    await raiseRiskFlag(guestId, 'FAILED_PAYMENTS', `${failures} failed card payments in 24 hours`, {
      now,
      session,
    });
  }
}

/**
 * A new booking: more than the daily number from one Guest raises BOOKING_VELOCITY. Checkouts that ended
 * without being paid don't count: one replaced when the Guest changed the dates or options, or one left
 * unpaid until its hold ran out.
 */
export async function checkBookingVelocity(guestId: Types.ObjectId, now = new Date()) {
  const settings = await getPlatformSettings();
  const count = await BookingModel.countDocuments({
    guestId,
    createdAt: mongoose.trusted({ $gte: new Date(now.getTime() - DAY_MS) }),
    ...notAbandonedCheckout(),
  });
  if (count > settings.risk.bookingsPerDay) {
    await raiseRiskFlag(guestId, 'BOOKING_VELOCITY', `${count} bookings started in 24 hours`, { now });
  }
}

/** Queues the card and Radar checks for a payment that went through, outside the webhook's transaction. */
export async function queuePaymentRiskCheck(paymentId: string, session: ClientSession) {
  await enqueue('risk.paymentCheck', { paymentId }, { uniqueKey: `risk.paymentCheck:${paymentId}`, session });
}

/**
 * `risk.paymentCheck`: reads the card's country and Radar's verdict from the payment's charge. A card
 * issued outside NZ and outside the country of the Guest's licence raises CARD_COUNTRY; Radar's elevated
 * or highest risk, or a manual review, raises RADAR_WARNING.
 */
export async function checkPaymentRisk(paymentId: string, now = new Date()) {
  const payment = await PaymentModel.findById(paymentId).lean();
  if (!payment) return;
  const booking = await BookingModel.findById(payment.bookingId).select('guestId ref').lean();
  if (!booking) return;
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId, {
    expand: ['latest_charge'],
  });
  const charge = intent.latest_charge as Stripe.Charge | string | null;
  if (!charge || typeof charge === 'string') return;

  const cardCountry = charge.payment_method_details?.card?.country;
  if (cardCountry && cardCountry !== 'NZ') {
    const guest = await UserModel.findById(booking.guestId)
      .select('driverLicence.country driverLicence.class')
      .lean();
    const cardPlace = regionNames.of(cardCountry) ?? cardCountry;
    // Compared as ISO codes: a licence saved as "USA" or "England" is read as US or GB.
    const licence = guest?.driverLicence;
    const licenceCode = licence ? licenceCountryCode(licence) : undefined;
    if (!licenceCode || licenceCode !== cardCountry.toUpperCase()) {
      const licencePlace = licence ? countryName(licenceCode ?? licence.country) : 'unknown';
      await raiseRiskFlag(
        booking.guestId,
        'CARD_COUNTRY',
        `Card issued in ${cardPlace} for ${booking.ref}; licence from ${licencePlace}`,
        { now },
      );
    }
  }

  const outcome = charge.outcome;
  if (outcome && (RADAR_WARNINGS.has(outcome.risk_level ?? '') || outcome.type === 'manual_review')) {
    await raiseRiskFlag(
      booking.guestId,
      'RADAR_WARNING',
      `Stripe Radar: ${outcome.risk_level ?? 'review'} risk on ${booking.ref}${outcome.reason ? ` (${outcome.reason})` : ''}`,
      { now },
    );
  }
}
