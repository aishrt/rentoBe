import mongoose from 'mongoose';
import Stripe from 'stripe';
import { stripe } from '../../integrations/stripe.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { BookingModel } from '../bookings/booking.model.js';
import { UserModel } from '../users/user.model.js';
import { PaymentModel, type PaymentStatus } from './payment.model.js';
import type { PaymentHistoryItem, SavedCard } from './payments.schemas.js';
import { ensureCustomer } from './stripe-customer.js';

/*
 * The Guest dashboard's payments (plan §8.1, item 7): the cards saved to their Stripe customer, to add
 * or remove, and their payment history with receipts and refunds. Card details stay with Stripe.
 */

const cardNotFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find that card.");

function toSavedCard(method: Stripe.PaymentMethod, now: Date): SavedCard | null {
  const card = method.card;
  if (!card) return null;
  // A card is good until the end of its expiry month.
  const expiresAfter = new Date(Date.UTC(card.exp_year, card.exp_month, 1));
  const type = card.wallet?.type;
  const wallet = type === 'apple_pay' ? 'apple_pay' : type === 'google_pay' ? 'google_pay' : undefined;
  return {
    id: method.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    expired: expiresAfter <= now,
    ...(wallet && { wallet }),
  };
}

async function customerOf(userId: string): Promise<string | undefined> {
  const user = await UserModel.findById(userId).select('stripeCustomerId status').lean();
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  return user.stripeCustomerId;
}

/** GET /me/payment-methods: the Guest's saved cards. None until their first payment or saved card. */
export async function listSavedCards(userId: string, now = new Date()): Promise<SavedCard[]> {
  const customer = await customerOf(userId);
  if (!customer) return [];
  const methods = await stripe().customers.listPaymentMethods(customer, { type: 'card', limit: 20 });
  return methods.data.flatMap((method) => toSavedCard(method, now) ?? []);
}

/**
 * POST /me/payment-methods/setup: a SetupIntent for the Payment Element to save one card for later
 * (plan §8.1, items 3 and 7), so checkout and post-trip charges can use it.
 */
export async function startCardSetup(userId: string): Promise<{ clientSecret: string }> {
  const customer = (await customerOf(userId)) ?? (await ensureCustomer(userId));
  const intent = await stripe().setupIntents.create({
    customer,
    usage: 'off_session',
    automatic_payment_methods: { enabled: true },
    metadata: { purpose: 'saved_card', userId },
  });
  return { clientSecret: intent.client_secret! };
}

/** DELETE /me/payment-methods/{id}: removes one of the Guest's own saved cards. */
export async function removeSavedCard(userId: string, paymentMethodId: string): Promise<void> {
  if (!/^pm_\w+$/.test(paymentMethodId)) throw cardNotFound();
  const customer = await customerOf(userId);
  if (!customer) throw cardNotFound();
  const client = stripe();
  let method: Stripe.PaymentMethod;
  try {
    method = await client.paymentMethods.retrieve(paymentMethodId);
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) throw cardNotFound();
    throw error;
  }
  const owner = typeof method.customer === 'string' ? method.customer : method.customer?.id;
  // Someone else's card looks the same as one that doesn't exist.
  if (owner !== customer) throw cardNotFound();
  await client.paymentMethods.detach(paymentMethodId);
}

const SHOWN: PaymentStatus[] = ['AUTHORISED', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const HAS_RECEIPT: PaymentStatus[] = ['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

/**
 * GET /me/payments: what the Guest has paid, newest first, with refunds (plan §8.1, item 7). Attempts
 * that never charged anything (unfinished, released or failed at checkout) are left out; a failed
 * extra charge stays, because it still has to be paid.
 */
export async function listPaymentHistory(userId: string): Promise<PaymentHistoryItem[]> {
  const bookings = await BookingModel.find({ guestId: userId }).select('ref vehicleSnapshot.title').lean();
  if (bookings.length === 0) return [];
  const byId = new Map(bookings.map((booking) => [booking._id.toString(), booking]));
  const payments = await PaymentModel.find({
    bookingId: mongoose.trusted({ $in: bookings.map((booking) => booking._id) }),
    status: mongoose.trusted({ $in: SHOWN }),
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return payments.flatMap((payment): PaymentHistoryItem[] => {
    const booking = byId.get(payment.bookingId.toString());
    if (!booking || (payment.status === 'FAILED' && payment.type === 'BOOKING')) return [];
    const refunds = payment.refunds.map((refund) => ({
      amountCents: refund.amountCents,
      status: refund.status,
      at: refund.createdAt.toISOString(),
    }));
    return [
      {
        id: payment._id.toString(),
        bookingRef: booking.ref,
        vehicleTitle: booking.vehicleSnapshot.title,
        type: payment.type,
        amountCents: payment.amountCents,
        status: payment.status as PaymentHistoryItem['status'],
        ...(payment.method && { method: payment.method }),
        at: payment.createdAt.toISOString(),
        refundedCents: payment.refunds
          .filter((refund) => refund.status !== 'FAILED')
          .reduce((sum, refund) => sum + refund.amountCents, 0),
        refunds,
        // A paid extra charge is on the booking's receipt, under "Charges after the trip".
        hasReceipt:
          payment.type === 'EXTRA_CHARGE'
            ? payment.status === 'SUCCEEDED'
            : payment.type === 'BOOKING' && HAS_RECEIPT.includes(payment.status),
      },
    ];
  });
}
