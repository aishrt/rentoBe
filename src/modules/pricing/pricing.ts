import { nzTripDays } from '../../lib/nz-time.js';
import type { PlatformSettings, ProtectionPlan } from '../admin/platform-settings.schemas.js';
import type { BookingPrice, LineItem } from '../bookings/booking.model.js';
import type { DeliveryType, VehiclePricing } from '../vehicles/vehicle.model.js';

/*
 * The pricing engine (plan §5): the only place a price is calculated. Search results, the listing
 * page, checkout, bookings and receipts all show what this returns; the website never works out a
 * price itself.
 */

export const LINE_ITEM_CODES = [
  'RENTAL',
  'WEEKLY_DISCOUNT',
  'MONTHLY_DISCOUNT',
  'SERVICE_FEE',
  'PROTECTION',
  'PICKUP_DELIVERY',
  'RETURN_DELIVERY',
] as const;
export type LineItemCode = (typeof LINE_ITEM_CODES)[number];

/** A delivery or pickup choice as priced: the Host's location costs nothing, delivery has its fee. */
export interface PricedDeliveryOption {
  type: DeliveryType;
  label: string;
  feeCents: number;
}

export interface PriceInput {
  startAt: Date;
  endAt: Date;
  pricing: Pick<VehiclePricing, 'dailyCents' | 'weeklyDiscountPct' | 'monthlyDiscountPct'>;
  /** Where the Guest collects the car. Left out, the car is collected at the Host's location for free. */
  pickup?: PricedDeliveryOption;
  /** Where the Guest returns it. */
  dropoff?: PricedDeliveryOption;
  /** The plan on this booking; none when no plan is mandatory and the Guest chose none. */
  protectionPlan?: Pick<ProtectionPlan, 'code' | 'name' | 'dailyPriceCents' | 'mandatory'>;
  fees: PlatformSettings['fees'];
  /**
   * PROVISIONAL (plan §5, §16 item 7): every line carries GST for now. Whether an unregistered Host's
   * rental does is the client's accountant's call; the confirmed rule changes only gstFor() below, and
   * the breakdown, receipts and payouts follow.
   */
  hostGstRegistered: boolean;
}

export interface PriceQuote {
  days: number;
  /** Every line with its own GST, mandatory ones first (checkout shows them in two groups, spec §7). */
  lineItems: LineItem[];
  price: BookingPrice;
}

/** A weekly discount from 7 days, a monthly one from 28 (plan §5). */
export const WEEKLY_DISCOUNT_DAYS = 7;
export const MONTHLY_DISCOUNT_DAYS = 28;

const percentOf = (cents: number, pct: number) => Math.round((cents * pct) / 100);

/** The GST inside a GST-inclusive amount: 3/23 of it at 15 %. Negative for a discount line. */
function gstFor(amountCents: number, fees: PlatformSettings['fees'], _hostGstRegistered: boolean): number {
  const rate = fees.gstRatePct;
  return Math.round((amountCents * rate) / (100 + rate));
}

const DELIVERY_LABELS: Record<DeliveryType, { pickup: string; dropoff: string }> = {
  PICKUP: { pickup: 'Collect from the host', dropoff: 'Return to the host' },
  DELIVERY: { pickup: 'Delivery to your address', dropoff: 'Collection from your address' },
  AIRPORT: { pickup: 'Airport delivery', dropoff: 'Airport return' },
  CUSTOM: { pickup: 'Delivery to', dropoff: 'Return at' },
};

/**
 * The price of a trip (plan §5), GST-inclusive, in whole NZD cents:
 *
 *   rental      = daily price × days, less a weekly (7+ days) or monthly (28+ days) discount
 *   delivery    = the pickup option's fee + the return option's fee
 *   service fee = rental × the Guest service fee %
 *   protection  = the plan's daily price × days
 *   total       = rental + delivery + service fee + protection, with the GST inside it shown per line
 *   Host payout = rental + delivery − rental × the Host commission %
 */
export function calculatePrice(input: PriceInput): PriceQuote {
  const { pricing, fees } = input;
  const days = nzTripDays(input.startAt, input.endAt);
  const line = (code: LineItemCode, label: string, amountCents: number, mandatory: boolean): LineItem => ({
    code,
    label,
    amountCents,
    gstCents: gstFor(amountCents, fees, input.hostGstRegistered),
    mandatory,
  });

  const baseCents = pricing.dailyCents * days;
  const lines: LineItem[] = [
    line(
      'RENTAL',
      `${days} ${days === 1 ? 'day' : 'days'} × ${dollars(pricing.dailyCents)}`,
      baseCents,
      true,
    ),
  ];

  let discountCents = 0;
  if (days >= MONTHLY_DISCOUNT_DAYS && pricing.monthlyDiscountPct > 0) {
    discountCents = percentOf(baseCents, pricing.monthlyDiscountPct);
    lines.push(
      line('MONTHLY_DISCOUNT', `Monthly discount (${pricing.monthlyDiscountPct}%)`, -discountCents, true),
    );
  } else if (days >= WEEKLY_DISCOUNT_DAYS && pricing.weeklyDiscountPct > 0) {
    discountCents = percentOf(baseCents, pricing.weeklyDiscountPct);
    lines.push(
      line('WEEKLY_DISCOUNT', `Weekly discount (${pricing.weeklyDiscountPct}%)`, -discountCents, true),
    );
  }
  const rentalCents = baseCents - discountCents;

  const serviceFeeCents = percentOf(rentalCents, fees.guestServiceFeePct);
  lines.push(line('SERVICE_FEE', 'Service fee', serviceFeeCents, true));

  let protectionCents = 0;
  if (input.protectionPlan) {
    protectionCents = input.protectionPlan.dailyPriceCents * days;
    lines.push(
      line(
        'PROTECTION',
        `${input.protectionPlan.name} protection (${days} × ${dollars(input.protectionPlan.dailyPriceCents)})`,
        protectionCents,
        input.protectionPlan.mandatory,
      ),
    );
  }

  let deliveryCents = 0;
  for (const [code, option, leg] of [
    ['PICKUP_DELIVERY', input.pickup, 'pickup'],
    ['RETURN_DELIVERY', input.dropoff, 'dropoff'],
  ] as const) {
    if (!option || option.feeCents <= 0) continue;
    deliveryCents += option.feeCents;
    const prefix = DELIVERY_LABELS[option.type][leg];
    lines.push(
      line(code, option.type === 'DELIVERY' ? prefix : `${prefix}: ${option.label}`, option.feeCents, false),
    );
  }

  const totalCents = rentalCents + deliveryCents + serviceFeeCents + protectionCents;
  const commissionCents = percentOf(rentalCents, fees.hostCommissionPct);
  // Mandatory lines first, as checkout shows them (spec §7), each group in the order above.
  const lineItems = [...lines.filter((item) => item.mandatory), ...lines.filter((item) => !item.mandatory)];

  return {
    days,
    lineItems,
    price: {
      subtotalCents: rentalCents,
      deliveryCents,
      serviceFeeCents,
      protectionCents,
      gstCents: lineItems.reduce((sum, item) => sum + item.gstCents, 0),
      totalCents,
      hostPayoutCents: rentalCents + deliveryCents - commissionCents,
      platformFeeCents: serviceFeeCents + commissionCents,
    },
  };
}

/** The plan every booking includes unless the Guest picks another: the mandatory one, if any. */
export function defaultProtectionPlan(plans: ProtectionPlan[]): ProtectionPlan | undefined {
  return plans.find((plan) => plan.mandatory);
}

function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString('en-NZ', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
