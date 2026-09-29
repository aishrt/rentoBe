/**
 * Sets up the Stripe account for the website (plan §8.1): turns on cards, Apple Pay and Google Pay,
 * registers the website's domain so the wallet buttons appear, and creates the webhook endpoint.
 * Safe to run again: it only changes what's missing. Run it once with sandbox keys now, and again
 * with live keys at launch.
 *
 *   npm run stripe:setup
 *   npm run stripe:setup -- --domain abc123.ngrok-free.app      (also register a tunnel for local testing)
 *   npm run stripe:setup -- --webhook-url https://api.rentovroom.com/api/v1/payments/webhook
 *
 * Uses STRIPE_SECRET_KEY from backend/.env (or the shell).
 */
import { parseArgs } from 'node:util';
import Stripe from 'stripe';
import { env } from '../src/env.js';
import { isStripeTestMode, stripe } from '../src/integrations/stripe.js';
import { STRIPE_WEBHOOK_EVENTS } from '../src/modules/payments/stripe-webhook.js';
import {
  DEFAULT_DOMAINS,
  DEFAULT_WEBHOOK_URL,
  METHOD_NAMES,
  REQUIRED_METHODS,
  note,
  platformPaymentMethodConfig,
  tick,
} from './stripe-shared.js';

const { values } = parseArgs({
  options: {
    domain: { type: 'string', multiple: true },
    'webhook-url': { type: 'string', default: DEFAULT_WEBHOOK_URL },
  },
});
const domains = [...new Set([...DEFAULT_DOMAINS, ...(values.domain ?? [])])];
const webhookUrl = values['webhook-url'];

async function turnOnPaymentMethods(client: Stripe) {
  console.log('Payment methods');
  const config = await platformPaymentMethodConfig(client);
  if (!config) throw new Error('No default payment method configuration found on this account');

  const off = REQUIRED_METHODS.filter((method) => config[method]?.display_preference.value !== 'on');
  if (off.length > 0) {
    await client.paymentMethodConfigurations.update(
      config.id,
      Object.fromEntries(off.map((method) => [method, { display_preference: { preference: 'on' } }])),
    );
  }
  for (const method of REQUIRED_METHODS) {
    tick(`${METHOD_NAMES[method]} ${off.includes(method) ? 'turned on' : 'already on'}`);
  }
}

async function registerDomains(client: Stripe) {
  console.log('\nWallet domains');
  const { data: existing } = await client.paymentMethodDomains.list({ limit: 100 });
  for (const name of domains) {
    let domain = existing.find((candidate) => candidate.domain_name === name);
    if (!domain) {
      domain = await client.paymentMethodDomains.create({ domain_name: name });
    } else {
      if (!domain.enabled) await client.paymentMethodDomains.update(domain.id, { enabled: true });
      // Asks Stripe to check the domain again, e.g. after DNS or hosting changes.
      domain = await client.paymentMethodDomains.validate(domain.id);
    }
    tick(`${name}: Apple Pay ${domain.apple_pay.status}, Google Pay ${domain.google_pay.status}`);
    const error = domain.apple_pay.status_details?.error_message;
    if (error) note(`Apple Pay: ${error}`);
  }
}

async function createWebhook(client: Stripe) {
  console.log('\nWebhook');
  if (!webhookUrl.startsWith('https://')) throw new Error('The webhook URL must start with https://');

  const { data: endpoints } = await client.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.find((endpoint) => endpoint.url === webhookUrl);
  if (existing) {
    const missing = existing.enabled_events.includes('*')
      ? []
      : STRIPE_WEBHOOK_EVENTS.filter((event) => !existing.enabled_events.includes(event));
    if (missing.length > 0) {
      await client.webhookEndpoints.update(existing.id, {
        enabled_events: [
          ...existing.enabled_events,
          ...missing,
        ] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
      });
      tick(`${webhookUrl}: added ${missing.join(', ')}`);
    } else {
      tick(`${webhookUrl} already set up`);
    }
    note('Its signing secret is under Developers → Webhooks → the endpoint → Reveal.');
    return;
  }

  const endpoint = await client.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    // Events arrive in the shape this SDK's types describe.
    api_version: Stripe.API_VERSION,
    description: 'Rento Vroom API: payments, refunds and disputes',
  });
  tick(`Created ${webhookUrl} for ${STRIPE_WEBHOOK_EVENTS.length} events`);
  console.log(`\n  Signing secret (shown once): ${endpoint.secret}`);
  console.log('  Put it in AWS Secrets Manager (rento-vroom/prod) as STRIPE_WEBHOOK_SECRET.');
  console.log("  Paste it; don't screenshot or share it. You can reveal it again in the Dashboard.");
}

async function main() {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set. Add your sandbox secret key (sk_test_…) to backend/.env.');
    process.exit(1);
  }
  const client = stripe();
  console.log(`\nSetting up Stripe with ${isStripeTestMode() ? 'sandbox' : 'LIVE'} keys\n`);

  await turnOnPaymentMethods(client);
  await registerDomains(client);
  await createWebhook(client);

  console.log('\nDone. Run `npm run stripe:check` to see the whole account.\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
