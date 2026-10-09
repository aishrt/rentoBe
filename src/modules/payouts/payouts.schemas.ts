import { z } from 'zod';
import { EXTRA_CHARGE_TYPES } from '../bookings/booking.model.js';
import { DEDUCTION_TYPES, PAYOUT_HOLD_REASONS, PAYOUT_STATUSES, PAYOUT_TYPES } from './payout.model.js';

/* Host payouts and payout setup (plan §8.1, items 8–9, 19–22) and the Guest's pay link (item 6). */

export const payoutAccountSchema = z
  .object({
    connected: z.boolean().meta({ description: 'The Host has started payout setup with Stripe' }),
    payoutsEnabled: z.boolean().meta({ description: 'Stripe can pay the Host: setup is finished' }),
    requirements: z.array(z.string()).meta({ description: 'What Stripe still needs, in plain words' }),
    bankDays: z.number().int().optional().meta({ description: 'Business days from a transfer to the bank' }),
    feesOwedCents: z
      .number()
      .int()
      .meta({ description: 'Host cancellation fees still to come off a payout' }),
    refundsOwedCents: z.number().int().meta({
      description: 'Host-funded refunds made after a booking’s payout, still to come off a payout',
    }),
  })
  .meta({ id: 'PayoutAccount' });

export const hostPayoutSchema = z
  .object({
    id: z.string(),
    type: z.enum(PAYOUT_TYPES),
    status: z.enum(PAYOUT_STATUSES),
    holdReason: z.enum(PAYOUT_HOLD_REASONS).optional(),
    amountCents: z.number().int().meta({ description: 'Sent (PAID), or due before deductions' }),
    grossCents: z.number().int().optional(),
    commissionCents: z.number().int().optional(),
    commissionGstCents: z.number().int().optional(),
    deductions: z
      .array(
        z.object({
          type: z.enum(DEDUCTION_TYPES),
          amountCents: z.number().int(),
          bookingRef: z
            .string()
            .optional()
            .meta({ description: 'HOST_FUNDED_REFUND: the booking the refund was made on' }),
        }),
      )
      .meta({ description: 'Each line taken off the payout' }),
    reversedCents: z
      .number()
      .int()
      .optional()
      .meta({ description: 'Taken back from the transfer for Host-funded refunds after it was paid' }),
    scheduledFor: z.iso.datetime(),
    paidAt: z.iso
      .datetime()
      .optional()
      .meta({ description: 'When it was sent to the Host’s Stripe balance' }),
    expectedInBankBy: z.iso.datetime().optional().meta({ description: 'Usually in the Host’s bank by then' }),
    booking: z.object({ ref: z.string(), vehicleTitle: z.string(), start: z.iso.datetime() }),
  })
  .meta({ id: 'HostPayout' });

export const hostPayoutsResponseSchema = z
  .object({ account: payoutAccountSchema, payouts: z.array(hostPayoutSchema) })
  .meta({ id: 'HostPayouts' });

export const linkResponseSchema = z
  .object({
    url: z.string().meta({ description: 'Open it straight away: it works once, for a few minutes' }),
  })
  .meta({ id: 'StripeLink' });

export const payLinkSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    vehicleTitle: z.string(),
    description: z.string(),
    type: z.enum(EXTRA_CHARGE_TYPES),
    amountCents: z.number().int(),
    status: z.enum(['DUE', 'PAID']),
    failureReason: z.string().optional(),
  })
  .meta({ id: 'PayLink' });

export const payLinkSessionSchema = z
  .object({ clientSecret: z.string(), amountCents: z.number().int(), currency: z.literal('nzd') })
  .meta({ id: 'PayLinkSession' });

const cents = z.number().int();

export const earningsRowSchema = z
  .object({
    ref: z.string(),
    vehicleTitle: z.string(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    status: z.enum([
      'CONFIRMED',
      'ACTIVE',
      'COMPLETED',
      'CANCELLED',
      'PAYMENT_PENDING',
      'PENDING',
      'DECLINED',
      'EXPIRED',
    ]),
    rentalCents: cents,
    rentalGstCents: cents,
    deliveryCents: cents,
    deliveryGstCents: cents,
    extraChargesCents: cents,
    extraChargesGstCents: cents,
    keptFeeCents: cents.meta({
      description: 'A cancelled trip: the Host’s part of the fee the Guest didn’t get back',
    }),
    commissionCents: cents,
    commissionGstCents: cents,
    hostFundedRefundsCents: cents,
    hostCancellationFeeCents: cents,
    netCents: cents,
  })
  .meta({ id: 'EarningsRow' });

export const earningsResponseSchema = z
  .object({
    summary: z.object({
      todayCents: cents,
      weekCents: cents.meta({ description: 'Monday to Sunday, NZ time' }),
      monthCents: cents,
      previousMonthCents: cents,
      lifetimeCents: cents,
      upcomingPayoutsCents: cents.meta({ description: 'Scheduled and held payouts, before deductions' }),
      platformFeesMonthCents: cents,
      platformFeesLifetimeCents: cents,
    }),
    months: z
      .array(z.object({ month: z.string().meta({ description: '2026-10' }), netCents: cents }))
      .meta({ description: 'The last 12 months, oldest first' }),
    bookings: z.array(earningsRowSchema).meta({ description: 'Newest trip first, up to 100' }),
    gstRegistered: z.boolean(),
  })
  .meta({ id: 'Earnings' });

export const statementQuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}(-\d{2})?$/, { error: 'Choose a month (2026-10) or a tax year (2027)' })
    .meta({ description: 'A month, 2026-10, or the NZ tax year ending 31 March, 2027' }),
});
