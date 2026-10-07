import mongoose from 'mongoose';
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
