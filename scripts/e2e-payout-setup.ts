/**
 * Finishes a Host's payout setup for the end-to-end tests (frontend/e2e), in place of Stripe's hosted
 * onboarding, which a test can't fill in (a phone code, an ID check and a bank account on Stripe's pages).
 * It applies the account state Stripe's `account.updated` webhook sends once the Host is done, through the
 * API's own code, so held payouts are released and approved listings go live exactly as they would.
 * The Host gets a stand-in account id (`acct_e2e_…`) if they have none: nothing is ever paid to it, because
 * the tests cancel their bookings. Refuses to run in production or with live Stripe keys.
 *
 *   npx tsx scripts/e2e-payout-setup.ts e2e.host.123@rentovroom.test
 */
import type Stripe from 'stripe';
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { applyAccountState } from '../src/modules/payouts/connect.service.js';
import { UserModel } from '../src/modules/users/user.model.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Pass the Host’s email: npx tsx scripts/e2e-payout-setup.ts <email>');
if (env.NODE_ENV === 'production' || env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  throw new Error('This stands in for Stripe in local tests only. It never runs in production.');
}

await connectDb();
try {
  const host = await UserModel.findOne({ email }).select('hostProfile');
  if (host?.hostProfile?.status !== 'APPROVED') throw new Error(`${email} isn't an approved Host.`);
  const accountId = host.hostProfile.stripeAccountId ?? `acct_e2e_${host.id}`;
  if (!host.hostProfile.stripeAccountId) {
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.stripeAccountId': accountId } });
  }
  await applyAccountState({
    id: accountId,
    payouts_enabled: true,
    capabilities: { transfers: 'active' },
    requirements: { currently_due: [], past_due: [] },
    settings: { payouts: { schedule: { delay_days: 2 } } },
  } as unknown as Stripe.Account);
  console.log(`Payout setup finished for ${email} (${accountId}).`);
} finally {
  await disconnectDb();
}
