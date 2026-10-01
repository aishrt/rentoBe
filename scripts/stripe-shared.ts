/** What `npm run stripe:check` and `npm run stripe:setup` both need (plan §8.1). */
import type Stripe from 'stripe';

/**
 * The website domains that show Apple Pay and Google Pay. The bare domain redirects to www; the
 * staging website uses the same API and Stripe account (plan §13.3), so its wallets work too.
 */
export const DEFAULT_DOMAINS = ['www.rentovroom.com', 'staging.rentovroom.com'];
export const WEBHOOK_PATH = '/api/v1/payments/webhook';
export const DEFAULT_WEBHOOK_URL = `https://api.rentovroom.com${WEBHOOK_PATH}`;

/** Cards, and the two wallets most visitors will pay with. */
export const REQUIRED_METHODS = ['card', 'apple_pay', 'google_pay'] as const;
export type RequiredMethod = (typeof REQUIRED_METHODS)[number];
export const METHOD_NAMES: Record<RequiredMethod, string> = {
  card: 'Cards',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
};

/**
 * The payment method settings used for the platform's own charges: the default configuration that
 * belongs to no Connect application. (Connected accounts have their own, which our charges don't
 * use.) Says which one it picked, so a wrong pick is easy to spot.
 */
export async function platformPaymentMethodConfig(client: Stripe) {
  const { data } = await client.paymentMethodConfigurations.list({ limit: 100 });
  const candidates = data.filter((config) => config.is_default && !config.application && !config.parent);
  const [config] = candidates;
  if (config) console.log(`  Using the configuration "${config.name}" (${config.id})`);
  if (candidates.length > 1) {
    note(
      `Other default configurations: ${candidates
        .slice(1)
        .map((other) => `"${other.name}" (${other.id})`)
        .join(', ')}`,
    );
  }
  return config ?? null;
}

/** The payment method types turned on in a configuration, e.g. ['card', 'apple_pay', 'link']. */
export function methodsTurnedOn(config: Stripe.PaymentMethodConfiguration): string[] {
  return Object.entries(config)
    .filter(
      ([, value]) =>
        (value as { display_preference?: { value?: string } })?.display_preference?.value === 'on',
    )
    .map(([key]) => key)
    .sort();
}

export const tick = (text: string) => console.log(`  ✓ ${text}`);
export const cross = (text: string) => console.log(`  ✗ ${text}`);
export const note = (text: string) => console.log(`  ! ${text}`);
