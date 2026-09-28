import type { PlatformSettings } from '../../src/modules/admin/platform-settings.schemas.js';
import type { BookingPrice, LineItem } from '../../src/modules/bookings/booking.model.js';

/*
 * Completed demo trips with reviews, so screens that show reviews, ratings and trip history can be built
 * before the booking and review features exist (plan §9, Days 2–3). Demo data only.
 */

/** How many past trips each car in DEMO_VEHICLES has. Some have none, so listings also show the New label. */
export const TRIPS_PER_VEHICLE = [2, 1, 1, 0, 2, 1, 1, 1, 0, 2, 1, 1, 2, 1, 0, 1, 1, 1, 1, 0];

/** Demo booking references start RV-DM, so a re-run can find and replace them. */
export const DEMO_REF_PREFIX = 'RV-DM';

export function demoRef(tripNumber: number): string {
  return `${DEMO_REF_PREFIX}${String(tripNumber).padStart(4, '0')}`;
}

export const GUEST_REVIEWS = [
  'Spotless car and a really easy handover. Would book again.',
  'Great communication, and the car was exactly as described.',
  'Picked up right on time and the car drove beautifully. Thanks!',
  'Clean, comfortable and economical. Pickup was simple.',
  'Really helpful host with good local tips. The car was perfect for our trip.',
  'Smooth from start to finish. The check-in photos took two minutes.',
  'Handled the mountain roads with ease, and the return was quick.',
  'Good value and a friendly host. A couple of small marks, all noted at check-in.',
];

export const HOST_REVIEWS = [
  'Returned the car clean and on time. Welcome back any time.',
  'Great communication and took good care of the car.',
  'Easy to deal with, and the car came back just as it left.',
  'Friendly guest, on time for pickup and return.',
];

/** Star scores for the nth review, mostly fives with some fours. */
export function demoStars(n: number): number {
  return [5, 5, 4, 5, 5, 4, 5][n % 7]!;
}

const gstOf = (amountCents: number, settings: PlatformSettings) => {
  const rate = settings.fees.gstRatePct;
  // GST-inclusive: the GST part of an amount is rate / (100 + rate) of it (3/23 at 15%).
  return Math.round((amountCents * rate) / (100 + rate));
};

/**
 * A short trip's price from the settings, with no delivery and the mandatory protection plan. The real
 * pricing engine (plan §5) is built in Phase 2; demo trips are under a week, so no discount applies.
 */
export function demoPrice(
  dailyCents: number,
  days: number,
  settings: PlatformSettings,
): { price: BookingPrice; lineItems: LineItem[] } {
  const plan =
    settings.protectionPlans.find((candidate) => candidate.mandatory) ?? settings.protectionPlans[0]!;
  const rental = dailyCents * days;
  const serviceFee = Math.round((rental * settings.fees.guestServiceFeePct) / 100);
  const protection = plan.dailyPriceCents * days;
  const commission = Math.round((rental * settings.fees.hostCommissionPct) / 100);

  const lineItems: LineItem[] = [
    { code: 'RENTAL', label: `Rental (${days} days)`, amountCents: rental, mandatory: true },
    { code: 'SERVICE_FEE', label: 'Service fee', amountCents: serviceFee, mandatory: true },
    {
      code: 'PROTECTION',
      label: `${plan.name} protection`,
      amountCents: protection,
      mandatory: plan.mandatory,
    },
  ].map((item) => ({ ...item, gstCents: gstOf(item.amountCents, settings) }));

  const totalCents = rental + serviceFee + protection;
  return {
    lineItems,
    price: {
      subtotalCents: rental,
      deliveryCents: 0,
      serviceFeeCents: serviceFee,
      protectionCents: protection,
      gstCents: lineItems.reduce((sum, item) => sum + item.gstCents, 0),
      totalCents,
      hostPayoutCents: rental - commission,
      platformFeeCents: serviceFee + commission,
    },
  };
}
