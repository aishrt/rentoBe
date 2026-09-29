import Stripe from 'stripe';
import { env } from '../env.js';
import { HttpError } from '../lib/http-error.js';

/**
 * Every charge, refund and payout is in NZD. Visitors can see prices in AUD, USD, EUR or CAD, but
 * only as estimates: their card issuer converts the NZD charge (plan §12.7).
 */
export const CHARGE_CURRENCY = 'nzd';

let client: Stripe | undefined;

export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Sandbox keys (sk_test_) move no real money. */
export function isStripeTestMode(): boolean {
  return env.STRIPE_SECRET_KEY?.includes('_test_') ?? false;
}

/**
 * The Stripe API client (plan §8), pinned to the API version of the installed SDK. Until the keys
 * are set, anything that needs it answers 503, so the rest of the site keeps working.
 */
export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new HttpError(
      503,
      'PAYMENTS_UNAVAILABLE',
      "Payments aren't available right now. Please try again later.",
    );
  }
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'Rento Vroom', url: 'https://www.rentovroom.com' },
  });
  return client;
}
