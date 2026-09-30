import { describe, expect, it } from 'vitest';
import {
  addNzDays,
  fromNzWallClock,
  nzTripDays,
  parseNzDateTime,
  startOfNzDay,
  toNzLocalDateTime,
  toNzWallClock,
} from '../src/lib/nz-time.js';
import { formatNzAddress, formatNzDateTime, formatNzdExact } from '../src/lib/format.js';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { calculatePrice, defaultProtectionPlan } from '../src/modules/pricing/pricing.js';

const fees = DEFAULT_SETTINGS.fees;
const basic = defaultProtectionPlan(DEFAULT_SETTINGS.protectionPlans)!;
const pricing = { dailyCents: 8900, weeklyDiscountPct: 10, monthlyDiscountPct: 25 };
const nz = (value: string) => parseNzDateTime(value)!;

describe('NZ time', () => {
  it('reads website times as NZ time and full ISO times as given', () => {
    // NZ standard time is UTC+12, daylight time (from late September) UTC+13.
    expect(nz('2026-07-01T10:00').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(nz('2026-12-01T10:00').toISOString()).toBe('2026-11-30T21:00:00.000Z');
    expect(nz('2026-12-01T10:00:00Z').toISOString()).toBe('2026-12-01T10:00:00.000Z');
    expect(parseNzDateTime('2026-02-30T10:00')).toBeNull();
    expect(parseNzDateTime('2026-12-01T25:00')).toBeNull();
    expect(parseNzDateTime('tomorrow')).toBeNull();
  });

  it('round-trips wall-clock times across daylight saving', () => {
    const instant = fromNzWallClock(2026, 9, 27, 9, 30); // the morning daylight saving starts
    expect(toNzLocalDateTime(instant)).toBe('2026-09-27T09:30');
    expect(toNzWallClock(instant)).toMatchObject({ year: 2026, month: 9, day: 27, hour: 9, weekday: 0 });
    expect(toNzLocalDateTime(startOfNzDay(instant))).toBe('2026-09-27T00:00');
    expect(toNzLocalDateTime(addNzDays(fromNzWallClock(2026, 9, 26, 10), 1))).toBe('2026-09-27T10:00');
  });

  it('counts trip days on NZ clocks, with any part day as a full day', () => {
    expect(nzTripDays(nz('2026-10-12T10:00'), nz('2026-10-15T10:00'))).toBe(3);
    expect(nzTripDays(nz('2026-10-12T10:00'), nz('2026-10-15T10:30'))).toBe(4);
    expect(nzTripDays(nz('2026-10-12T10:00'), nz('2026-10-12T14:00'))).toBe(1);
    // 23 hours long on the clock-change weekend, but still one day.
    expect(nzTripDays(nz('2026-09-26T10:00'), nz('2026-09-27T10:00'))).toBe(1);
    expect(nzTripDays(nz('2027-04-03T10:00'), nz('2027-04-04T10:00'))).toBe(1);
  });

  it('formats NZ amounts, times and addresses', () => {
    expect(formatNzdExact(8950)).toBe('$89.50');
    expect(formatNzdExact(-4200)).toBe('-$42.00');
    expect(formatNzDateTime(nz('2026-10-12T10:00'))).toBe('Mon, 12 Oct 2026, 10:00 am');
    expect(
      formatNzAddress({
        streetNumber: '12',
        street: 'Queen Street',
        suburb: 'Auckland Central',
        city: 'Auckland',
        postcode: '1010',
      }),
    ).toBe('12 Queen Street, Auckland Central, Auckland 1010');
    expect(
      formatNzAddress({
        unit: '3',
        streetNumber: '5',
        street: 'Beach Road',
        city: 'Napier',
        postcode: '4110',
      }),
    ).toBe('3/5 Beach Road, Napier 4110');
  });
});

describe('Pricing engine', () => {
  it('prices a short trip with the mandatory protection plan', () => {
    const quote = calculatePrice({
      startAt: nz('2026-10-12T10:00'),
      endAt: nz('2026-10-15T10:00'),
      pricing,
      protectionPlan: basic,
      fees,
      hostGstRegistered: false,
    });

    expect(quote.days).toBe(3);
    expect(quote.lineItems.map((item) => [item.code, item.amountCents, item.mandatory])).toEqual([
      ['RENTAL', 26_700, true],
      ['SERVICE_FEE', 2_670, true],
      ['PROTECTION', 4_500, true],
    ]);
    expect(quote.price).toEqual({
      subtotalCents: 26_700,
      deliveryCents: 0,
      serviceFeeCents: 2_670,
      protectionCents: 4_500,
      // 3/23 of each line: 3483 + 348 + 587.
      gstCents: 4_418,
      totalCents: 33_870,
      hostPayoutCents: 21_360,
      platformFeeCents: 2_670 + 5_340,
    });
  });

  it('applies the weekly discount from 7 days and the monthly one from 28, as their own lines', () => {
    const week = calculatePrice({
      startAt: nz('2026-10-01T10:00'),
      endAt: nz('2026-10-08T10:00'),
      pricing,
      fees,
      hostGstRegistered: false,
    });
    expect(week.lineItems.find((item) => item.code === 'WEEKLY_DISCOUNT')).toMatchObject({
      label: 'Weekly discount (10%)',
      amountCents: -6_230,
      mandatory: true,
    });
    expect(week.price.subtotalCents).toBe(62_300 - 6_230);

    const month = calculatePrice({
      startAt: nz('2026-10-01T10:00'),
      endAt: nz('2026-10-29T10:00'),
      pricing,
      fees,
      hostGstRegistered: false,
    });
    expect(month.lineItems.map((item) => item.code)).toEqual(['RENTAL', 'MONTHLY_DISCOUNT', 'SERVICE_FEE']);
    expect(month.price.subtotalCents).toBe(8900 * 28 - Math.round(8900 * 28 * 0.25));
  });

  it('lists delivery and a chosen plan as optional, after the mandatory lines', () => {
    const premium = DEFAULT_SETTINGS.protectionPlans.find((plan) => plan.code === 'PREMIUM')!;
    const airport = { type: 'AIRPORT' as const, label: 'Auckland Airport', feeCents: 4_500 };
    const quote = calculatePrice({
      startAt: nz('2026-10-12T10:00'),
      endAt: nz('2026-10-14T10:00'),
      pricing,
      pickup: airport,
      dropoff: airport,
      protectionPlan: premium,
      fees,
      hostGstRegistered: false,
    });

    expect(quote.lineItems.map((item) => [item.label, item.mandatory])).toEqual([
      ['2 days × $89', true],
      ['Service fee', true],
      ['Premium protection (2 × $45)', false],
      ['Airport delivery: Auckland Airport', false],
      ['Airport return: Auckland Airport', false],
    ]);
    expect(quote.price.deliveryCents).toBe(9_000);
    // The Host gets the delivery fees and the rental, less commission on the rental only.
    expect(quote.price.hostPayoutCents).toBe(17_800 + 9_000 - 3_560);
    expect(quote.price.totalCents).toBe(17_800 + 1_780 + 9_000 + 9_000);
    expect(quote.price.gstCents).toBe(quote.lineItems.reduce((sum, item) => sum + item.gstCents, 0));
  });

  it('charges nothing for collecting from the Host', () => {
    const quote = calculatePrice({
      startAt: nz('2026-10-12T10:00'),
      endAt: nz('2026-10-13T10:00'),
      pricing,
      pickup: { type: 'PICKUP', label: 'Ponsonby', feeCents: 0 },
      dropoff: { type: 'PICKUP', label: 'Ponsonby', feeCents: 0 },
      fees,
      hostGstRegistered: false,
    });
    expect(quote.lineItems.map((item) => item.code)).toEqual(['RENTAL', 'SERVICE_FEE']);
  });
});
