import mongoose from 'mongoose';
import { logger } from '../../integrations/logger.js';
import { stripe } from '../../integrations/stripe.js';
import { unauthenticated } from '../../lib/http-error.js';
import { UserModel } from '../users/user.model.js';

/**
 * The Guest's Stripe customer, created on their first payment or saved card (plan §8.1, item 7). The
 * idempotency key means two requests at once still create only one.
 */
export async function ensureCustomer(userId: string): Promise<string> {
  const user = await UserModel.findById(userId).select('email firstName lastName stripeCustomerId');
  if (!user) throw unauthenticated();
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe().customers.create(
    { email: user.email, name: `${user.firstName} ${user.lastName}`, metadata: { userId: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  await UserModel.updateOne(
    { _id: user._id, stripeCustomerId: mongoose.trusted({ $exists: false }) },
    { $set: { stripeCustomerId: customer.id } },
  );
  return customer.id;
}

/**
 * When an account closes (plan §8.2, §14): the Guest's saved cards are detached, and the Stripe customer
 * keeps no name, email, phone, address or metadata. The customer is updated rather than deleted, so the
 * payments and refunds kept for the law still resolve in Stripe. Never throws: a failure is logged with the
 * customer, for someone to finish in the Stripe Dashboard, and the closure goes ahead.
 */
export async function forgetCustomer(customerId: string): Promise<void> {
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      logger.warn({ err: error, customerId }, `Could not ${what} for a closed account in Stripe`);
    }
  };
  await attempt('remove the customer’s details', () =>
    stripe().customers.update(customerId, {
      name: 'Former member',
      email: '',
      phone: '',
      description: '',
      address: '',
      shipping: '',
      metadata: '',
    }),
  );
  await attempt('detach the saved cards', async () => {
    const methods = await stripe().customers.listPaymentMethods(customerId, { limit: 100 });
    for (const method of methods.data) await stripe().paymentMethods.detach(method.id);
  });
}
