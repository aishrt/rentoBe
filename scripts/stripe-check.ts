/**
 * Checks the Stripe account against what the website needs (plan §8): a New Zealand account that
 * settles in NZD, cards, Apple Pay and Google Pay turned on, the website's domains registered for the
 * wallets, and a webhook endpoint for every event the API handles. Changes nothing.
 *
 *   npm run stripe:check
 *
 * Uses STRIPE_SECRET_KEY from backend/.env (or the shell). `npm run stripe:setup` fixes most of what
 * it reports.
 */
import { env } from '../src/env.js';
import { isStripeTestMode, stripe } from '../src/integrations/stripe.js';
import { STRIPE_WEBHOOK_EVENTS } from '../src/modules/payments/stripe-webhook.js';
import {
  DEFAULT_DOMAINS,
  METHOD_NAMES,
  REQUIRED_METHODS,
  WEBHOOK_PATH,
  cross,
  methodsTurnedOn,
  note,
  platformPaymentMethodConfig,
  tick,
} from './stripe-shared.js';

let problems = 0;
const fail = (text: string) => {
  problems += 1;
  cross(text);
};

async function main() {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set. Add your sandbox secret key (sk_test_…) to backend/.env.');
    process.exit(1);
  }
  const client = stripe();

  const account = await client.accounts.retrieveCurrent();
  const name = account.settings?.dashboard.display_name ?? account.business_profile?.name ?? account.id;
  console.log(`\nStripe account: ${name} (${account.id}), ${isStripeTestMode() ? 'sandbox' : 'LIVE'} keys\n`);

  console.log('Account');
  if (account.country === 'NZ') tick('Registered in New Zealand');
  else
    fail(
      `Registered in ${account.country ?? 'an unknown country'}, not NZ. Host payouts and GST need an NZ account.`,
    );
  if (account.default_currency === 'nzd') tick('Settles in NZD');
  else fail(`Settles in ${account.default_currency?.toUpperCase() ?? 'an unknown currency'}, not NZD`);
  if (account.charges_enabled) tick('Can take payments');
  else if (isStripeTestMode())
    note("Can't take live payments until the account is activated (the sandbox works regardless)");
  else fail("Can't take payments yet: finish activating the account in the Dashboard");

  console.log('\nPayment methods (Settings → Payments → Payment methods)');
  const config = await platformPaymentMethodConfig(client);
  if (!config) {
    fail('No default payment method configuration found');
  } else {
    for (const method of REQUIRED_METHODS) {
      const setting = config[method];
      if (setting?.available) tick(`${METHOD_NAMES[method]} on`);
      else if (setting?.display_preference.value === 'on')
        note(`${METHOD_NAMES[method]} on, but not available yet on this account`);
      else fail(`${METHOD_NAMES[method]} off`);
    }
    const others = methodsTurnedOn(config).filter((method) => !REQUIRED_METHODS.includes(method as never));
    if (others.length > 0)
      note(
        `Also on: ${others.join(', ')}. The plan uses cards and wallets only; turn these off unless wanted.`,
      );
  }

  console.log('\nWallet domains (Settings → Payments → Payment method domains)');
  const { data: domains } = await client.paymentMethodDomains.list({ limit: 100 });
  for (const wanted of DEFAULT_DOMAINS) {
    const domain = domains.find((candidate) => candidate.domain_name === wanted);
    if (!domain) {
      fail(`${wanted} is not registered, so Apple Pay and Google Pay won't show there`);
      continue;
    }
    const wallets = `Apple Pay ${domain.apple_pay.status}, Google Pay ${domain.google_pay.status}`;
    if (domain.enabled && domain.apple_pay.status === 'active' && domain.google_pay.status === 'active') {
      tick(`${wanted}: ${wallets}`);
    } else {
      fail(`${wanted}: ${domain.enabled ? wallets : 'turned off'}`);
    }
  }
  const extra = domains.filter((domain) => !DEFAULT_DOMAINS.includes(domain.domain_name));
  if (extra.length > 0) note(`Also registered: ${extra.map((domain) => domain.domain_name).join(', ')}`);

  console.log('\nWebhook (Developers → Webhooks)');
  const { data: endpoints } = await client.webhookEndpoints.list({ limit: 100 });
  const ours = endpoints.filter((endpoint) => new URL(endpoint.url).pathname === WEBHOOK_PATH);
  if (ours.length === 0) fail(`No endpoint for ${WEBHOOK_PATH}`);
  for (const endpoint of ours) {
    const missing = endpoint.enabled_events.includes('*')
      ? []
      : STRIPE_WEBHOOK_EVENTS.filter((event) => !endpoint.enabled_events.includes(event));
    if (endpoint.status !== 'enabled') fail(`${endpoint.url} is ${endpoint.status}`);
    else if (missing.length > 0) fail(`${endpoint.url} is missing ${missing.join(', ')}`);
    else tick(`${endpoint.url} (API version ${endpoint.api_version ?? 'account default'})`);
  }
  if (!env.STRIPE_WEBHOOK_SECRET) note('STRIPE_WEBHOOK_SECRET is not set here, so this API rejects webhooks');

  console.log(
    problems === 0
      ? '\nAll good.\n'
      : `\n${problems} to fix. \`npm run stripe:setup\` fixes the payment methods, domains and webhook.\n`,
  );
  process.exitCode = problems === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
