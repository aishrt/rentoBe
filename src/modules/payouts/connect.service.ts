import type { ClientSession } from 'mongoose';
import Stripe from 'stripe';
import { env } from '../../env.js';
import { stripe } from '../../integrations/stripe.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { notify } from '../notifications/notify.js';
import { UserModel, type HostProfile } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { PayoutModel } from './payout.model.js';
import { releaseHeldPayouts } from './payouts.service.js';

/*
 * Payout setup with Stripe Connect Express (plan §8.1, items 8 and 20): the Host gives Stripe their bank
 * account and identity on Stripe's own pages; Rento Vroom keeps only the account id and whether payouts can
 * be sent. Listings approved before setup go live when it's finished (plan §8.2).
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
/** Stripe refuses a business website it can't reach, such as localhost in development; the description does. */
const publicSiteUrl = () => (siteUrl().startsWith('https://') ? siteUrl() : undefined);

/** Stripe's requirement codes in plain words, for the Host's to-do list. */
const REQUIREMENT_WORDS: [RegExp, string][] = [
  [/^external_account/, 'Your bank account'],
  [/verification\.(document|additional_document)/, 'A photo of your ID'],
  [/^tos_acceptance/, 'Stripe’s terms of service'],
  [/\.dob\./, 'Your date of birth'],
  [/\.address\./, 'Your address'],
  [/\.(phone|email)$/, 'Your contact details'],
  [/\.(first_name|last_name)$/, 'Your name'],
  [/^business_profile/, 'Your business details'],
  [/id_number/, 'Your IRD or ID number'],
];

function requirementWords(codes: string[]): string[] {
  const words = codes.map(
    (code) => REQUIREMENT_WORDS.find(([pattern]) => pattern.test(code))?.[1] ?? 'A few more details',
  );
  return [...new Set(words)];
}

export interface PayoutAccountView {
  connected: boolean;
  payoutsEnabled: boolean;
  /** What Stripe still needs, in plain words. */
  requirements: string[];
  /** Business days from a transfer to the bank. */
  bankDays?: number;
  /** Host cancellation fees still to come off a payout. */
  feesOwedCents: number;
  /** Host-funded refunds made after a booking's payout, still to come off one (plan §8.1, item 15). */
  refundsOwedCents: number;
}

export function payoutAccountView(profile: Partial<HostProfile> | undefined): PayoutAccountView {
  return {
    connected: Boolean(profile?.stripeAccountId),
    payoutsEnabled: Boolean(profile?.payoutsEnabled),
    requirements: profile?.payoutRequirements ?? [],
    ...(profile?.payoutDelayDays !== undefined && { bankDays: profile.payoutDelayDays }),
    feesOwedCents: profile?.feesOwedCents ?? 0,
    refundsOwedCents: (profile?.refundsOwed ?? []).reduce((sum, refund) => sum + refund.amountCents, 0),
  };
}

async function findHost(hostId: string) {
  const host = await UserModel.findById(hostId).select('email firstName status hostProfile');
  if (!host?.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  if (host.hostProfile.status !== 'APPROVED') {
    throw new HttpError(
      409,
      'HOST_NOT_APPROVED',
      'Payout setup opens once your Host application is approved.',
    );
  }
  return host;
}

/**
 * Applies a Stripe account's state (from `account.updated`, or read when the Host comes back from Stripe):
 * whether payouts can be sent and what's missing. Payouts held for the setup are released, and listings
 * waiting for it go live. Pass the webhook's transaction when there is one.
 */
export async function applyAccountState(account: Stripe.Account, session?: ClientSession): Promise<void> {
  const host = await UserModel.findOne({ 'hostProfile.stripeAccountId': account.id })
    .select('firstName hostProfile')
    .session(session ?? null);
  if (!host?.hostProfile) return;
  const enabled = Boolean(account.payouts_enabled) && account.capabilities?.transfers === 'active';
  const wasEnabled = host.hostProfile.payoutsEnabled;
  const due = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])];
  const delay = account.settings?.payouts?.schedule?.delay_days;

  await UserModel.updateOne(
    { _id: host._id },
    {
      $set: {
        'hostProfile.payoutsEnabled': enabled,
        'hostProfile.payoutRequirements': requirementWords(due),
        ...(typeof delay === 'number' && { 'hostProfile.payoutDelayDays': delay }),
      },
    },
    { session },
  );

  if (enabled && !wasEnabled) {
    await releaseHeldPayouts({ hostId: host._id }, 'PAYOUT_SETUP', { session });
    const waiting = await VehicleModel.updateMany(
      { hostId: host._id, payoutsReady: false },
      { $set: { payoutsReady: true } },
      { session },
    );
    if (waiting.modifiedCount > 0) forget('vehicles:featured');
    await notify(
      {
        userId: host._id,
        type: 'PAYOUT_SETUP_DONE',
        title: 'Payout setup is done',
        body:
          waiting.modifiedCount > 0
            ? 'Your approved listings are now live, and you’ll be paid after each trip.'
            : 'You’ll be paid 24 hours after each trip starts.',
        link: '/host/earnings',
      },
      { session },
    );
  } else if (!enabled && wasEnabled) {
    // Payouts wait with "payout setup needed" until Stripe has what it asked for (plan §8.1, item 20): the
    // scheduled ones show it at once, rather than when their transfer comes round.
    await PayoutModel.updateMany(
      { hostId: host._id, status: 'SCHEDULED' },
      { $set: { status: 'HELD', holdReason: 'PAYOUT_SETUP' } },
      { session },
    );
    await notify(
      {
        userId: host._id,
        type: 'PAYOUT_SETUP_NEEDED',
        title: 'Stripe needs more details before paying you',
        body: requirementWords(due).join(', ') || 'Check your payout setup.',
        link: '/host/earnings',
        email: {
          template: 'tripNotice',
          props: {
            firstName: host.firstName,
            heading: 'Stripe needs more details',
            paragraphs: [
              'Stripe has paused your payouts until you give them a few more details. Your earnings are safe and are paid as soon as it’s sorted.',
              `What’s needed: ${requirementWords(due).join(', ') || 'see your payout setup'}.`,
            ],
            buttonLabel: 'Update your payout setup',
            url: `${siteUrl()}/host/earnings`,
          },
        },
        dedupeKey: `PAYOUT_DISABLED:${host.id}:${account.id}:${due.join(',')}`,
      },
      { session },
    );
  }
}

/**
 * Makes the Host's Express account. The idempotency key stops a double click making two, but Stripe replays a
 * key's first answer for 24 hours, refusals included, so a refusal moves the Host on to a new key. A replayed
 * refusal (an earlier try's answer) gets one fresh try straight away.
 */
async function createExpressAccount(host: Awaited<ReturnType<typeof findHost>>): Promise<string> {
  let refusals = host.hostProfile!.connectRefusals ?? 0;
  for (let tries = 0; ; tries += 1) {
    try {
      const account = await stripe().accounts.create(
        {
          type: 'express',
          country: 'NZ',
          email: host.email,
          capabilities: { transfers: { requested: true } },
          business_type: 'individual',
          business_profile: {
            product_description: 'Renting out my car to guests on Rento Vroom',
            mcc: '7512',
            ...(publicSiteUrl() && { url: publicSiteUrl() }),
          },
          metadata: { userId: host.id },
        },
        {
          idempotencyKey:
            refusals > 0 ? `connect-account-${host.id}-${refusals}` : `connect-account-${host.id}`,
        },
      );
      return account.id;
    } catch (error) {
      const refused =
        error instanceof Stripe.errors.StripeError &&
        error.statusCode !== undefined &&
        error.statusCode < 500;
      if (!refused) throw error;
      refusals += 1;
      await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.connectRefusals': refusals } });
      if (tries > 0 || error.headers?.['idempotent-replayed'] !== 'true') throw error;
    }
  }
}

/**
 * POST /host/connect/onboarding-link: a link to Stripe's payout setup, making the Host's Express account
 * the first time. The link works once, for a few minutes.
 */
export async function onboardingLink(hostId: string): Promise<{ url: string }> {
  const host = await findHost(hostId);
  const client = stripe();
  let accountId = host.hostProfile!.stripeAccountId;
  if (!accountId) {
    accountId = await createExpressAccount(host);
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.stripeAccountId': accountId } });
  }
  const link = await client.accountLinks.create({
    account: accountId,
    refresh_url: `${siteUrl()}/host/earnings?payouts=refresh`,
    return_url: `${siteUrl()}/host/earnings?payouts=done`,
    type: 'account_onboarding',
    collection_options: { fields: 'currently_due' },
  });
  return { url: link.url };
}

/** POST /host/connect/sync: reads the account from Stripe, e.g. when the Host comes back from setup. */
export async function syncPayoutAccount(hostId: string): Promise<PayoutAccountView> {
  const host = await findHost(hostId);
  const accountId = host.hostProfile!.stripeAccountId;
  if (accountId) await applyAccountState(await stripe().accounts.retrieve(accountId));
  const fresh = await UserModel.findById(hostId).select('hostProfile').lean();
  return payoutAccountView(fresh?.hostProfile);
}

/** POST /host/connect/dashboard-link: Stripe's Express dashboard, for bank details and payout history. */
export async function dashboardLink(hostId: string): Promise<{ url: string }> {
  const host = await findHost(hostId);
  const accountId = host.hostProfile!.stripeAccountId;
  if (!accountId) throw new HttpError(409, 'NO_PAYOUT_ACCOUNT', 'Set up payouts first.');
  const link = await stripe().accounts.createLoginLink(accountId);
  return { url: link.url };
}
