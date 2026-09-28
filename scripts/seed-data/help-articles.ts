import type { HelpArticle } from '../../src/modules/help/help-article.model.js';

type SeedHelpArticle = Omit<HelpArticle, 'createdAt' | 'updatedAt'>;

/**
 * Draft help centre articles in Markdown, written by the team and approved by the client (plan §16,
 * item 18). They describe how the platform works without committing to fees, cover or eligibility
 * details the client hasn't confirmed yet.
 */
export const HELP_ARTICLES: SeedHelpArticle[] = [
  {
    slug: 'how-booking-works',
    title: 'How booking works',
    category: 'Booking',
    audience: 'GUEST',
    published: true,
    order: 1,
    body: `Search by place and dates, compare cars, then book in a few steps.

## Instant Book and requests

- **Instant Book** cars are confirmed as soon as your payment goes through.
- For other cars, you send a **request**. Your card is authorised, and the host has 24 hours to accept. If they decline or don't answer, the authorisation is released and you aren't charged.

## What you'll need

- A Rento Vroom account with a verified mobile number
- Your driver licence details, and an identity check before your first trip
- A card, Apple Pay or Google Pay

Your booking confirmation shows the pickup details and the host's contact number.`,
  },
  {
    slug: 'what-the-price-includes',
    title: 'What the price includes',
    category: 'Payments',
    audience: 'GUEST',
    published: true,
    order: 2,
    body: `Every price on Rento Vroom is in New Zealand dollars (NZD) and includes all mandatory charges, including GST.

## The price breakdown

Before you pay, you'll see:

- **Mandatory:** the rental (with any weekly or monthly discount on its own line), the service fee and any protection the car requires
- **Optional:** delivery or airport delivery, and a higher level of protection if you choose one
- The GST included, and the **total in NZD**

## Other currencies

You can show approximate prices in AUD, USD, EUR, CAD or GBP. You're always charged in NZD, and your card provider converts the amount, so your statement can differ slightly from the estimate.`,
  },
  {
    slug: 'driver-licences-and-eligibility',
    title: 'Driver licences and eligibility',
    category: 'Account',
    audience: 'GUEST',
    published: true,
    order: 3,
    body: `To drive a Rento Vroom car you need a licence that's valid for the whole trip and to meet the eligibility rules shown before you book.

## New Zealand licences

Enter your licence number, version and class. We check it against the eligibility rules and your identity check.

## Overseas licences

Visitors are welcome. If your licence isn't in English, you also need an **International Driving Permit** or an **approved translation**. Carry both with you while driving.`,
  },
  {
    slug: 'verifying-your-account',
    title: 'Verifying your account',
    category: 'Account',
    audience: 'ALL',
    published: true,
    order: 4,
    body: `Verification keeps guests and hosts safe.

1. **Email:** confirm the link we send when you sign up.
2. **Mobile:** enter the code we text you. Overseas numbers work too.
3. **Identity:** before your first trip, or when you apply to host, you complete a quick ID document and selfie check.

Most checks finish within minutes. If a check needs a manual review, our team usually answers within a day and we'll let you know by email.`,
  },
  {
    slug: 'pickup-and-return',
    title: 'Pickup and return',
    category: 'Trips',
    audience: 'ALL',
    published: true,
    order: 5,
    body: `Every trip starts and ends with a photo check in the app.

## At pickup

Take the guided photos of the car (front, rear, both sides, wheels, windscreen, interior and dashboard), then record the odometer and the fuel or battery level. Mark any existing damage on the car diagram.

## At return

Repeat the check. Each photo appears next to its pickup photo, so any new damage is easy to spot. Return the car with the fuel or charge level the listing asks for.

If the host isn't there, the guest takes the photos and the host confirms them later.`,
  },
  {
    slug: 'cancelling-a-booking',
    title: 'Cancelling a booking',
    category: 'Booking',
    audience: 'ALL',
    published: true,
    order: 6,
    body: `Each listing shows its cancellation policy before you book, and your booking keeps that policy even if the host changes it later.

## Guests

Open the trip and choose **Cancel**. You'll see exactly what will be refunded before you confirm. A request that the host hasn't answered yet can be withdrawn at no cost.

## Hosts

If you cancel a confirmed booking, the guest gets a full refund. Repeated cancellations affect your standing as a host.`,
  },
  {
    slug: 'reporting-an-incident',
    title: 'Reporting an accident, damage or breakdown',
    category: 'Safety',
    audience: 'ALL',
    published: true,
    order: 7,
    body: `**In an emergency, call 111 first.**

When everyone is safe:

1. Open the trip and choose **Report an issue**.
2. Pick the type (accident, damage, breakdown, theft or something else) and describe what happened.
3. Add photos and any documents.

You'll get a case number, and our support team keeps both sides updated until the case is resolved.`,
  },
  {
    slug: 'becoming-a-host',
    title: 'Becoming a host',
    category: 'Hosting',
    audience: 'HOST',
    published: true,
    order: 8,
    body: `Share your car when you're not using it.

1. **Apply to host.** Tell us about yourself and verify your identity.
2. **Add your car in six steps:** details, documents, photos, pricing, availability, and pickup and delivery options.
3. **We review the listing.** Support staff check your documents and photos before it goes live.

You choose the daily price, discounts, the dates it's available and where guests collect it. You can pause the listing at any time.`,
  },
  {
    slug: 'host-payouts',
    title: 'How host payouts work',
    category: 'Hosting',
    audience: 'HOST',
    published: true,
    order: 9,
    body: `Payouts go to your New Zealand bank account.

- Set up payouts from your host dashboard before your first listing goes live.
- Your share of each trip is released after the trip starts, once check-in is done.
- Your dashboard shows upcoming and paid payouts, the platform fee, and any deductions.

A payout can be held while an incident or payment dispute on the trip is open.`,
  },
];
