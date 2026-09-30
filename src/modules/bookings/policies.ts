import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import type { BookedCancellationTerms, Booking } from './booking.model.js';

/*
 * The cancellation policy engine (plan §5, §8.1 item 10, §8.2). It works from the booking's own copy
 * of its tier and prices, so later changes to the tiers or fees never change a booking already made.
 * The splits below are the launch defaults until the client decides (plan §16, item 3):
 *
 * - Guest cancels: the tier's refund percentage applies to the rental and the service fee; delivery
 *   and protection are always refunded. What's kept is the cancellation fee. The Host gets their share
 *   of the kept rental (settings), less the booking's commission.
 * - Host cancels: the Guest gets everything back, and the Host cancellation fee in settings is added
 *   to what the Host owes (taken from their next payout).
 * - A request withdrawn before the Host answers: the authorisation is released; nothing is charged.
 * - A Guest no-show is a Guest cancellation at the start time; a Host no-show is a Host cancellation.
 */

const HOUR_MS = 60 * 60 * 1000;

export type CancellationKind =
  | 'ABANDON_CHECKOUT'
  | 'WITHDRAW_REQUEST'
  | 'GUEST_CANCELLATION'
  | 'HOST_CANCELLATION'
  | 'PLATFORM_CANCELLATION';

export interface CancellationOutcome {
  kind: CancellationKind;
  /** What goes back to the Guest's card. */
  refundCents: number;
  /** What the Guest paid and doesn't get back. */
  feeCents: number;
  /** The Host's share of the fee, after commission. */
  hostShareCents: number;
  /** Added to what the Host owes, for a Host cancellation. */
  hostFeeCents: number;
  /** The refund percentage of the rental that applied, for a Guest cancellation. */
  refundPct: number;
  hoursBeforeStart: number;
}

type PricedBooking = Pick<Booking, 'price' | 'startAt'> & {
  cancellationTerms?: BookedCancellationTerms;
};

/** The first rule the timing meets, from the most generous down (plan §3, cancellation tiers). */
export function refundPctFor(terms: BookedCancellationTerms | undefined, hoursBeforeStart: number): number {
  if (!terms || terms.refunds.length === 0) return 0;
  const rules = [...terms.refunds].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  return rules.find((rule) => hoursBeforeStart >= rule.minHoursBefore)?.refundPct ?? 0;
}

const hoursBefore = (booking: PricedBooking, now: Date) =>
  (booking.startAt.getTime() - now.getTime()) / HOUR_MS;

/** The commission rate this booking was priced with: the rental and delivery less the Host's payout. */
function commissionRate(booking: PricedBooking): number {
  const { subtotalCents, deliveryCents, hostPayoutCents } = booking.price;
  if (subtotalCents <= 0) return 0;
  return (subtotalCents + deliveryCents - hostPayoutCents) / subtotalCents;
}

export function guestCancellation(
  booking: PricedBooking,
  settings: Pick<PlatformSettings, 'cancellation'>,
  now = new Date(),
): CancellationOutcome {
  const hours = hoursBefore(booking, now);
  const refundPct = refundPctFor(booking.cancellationTerms, hours);
  const { subtotalCents, serviceFeeCents, totalCents } = booking.price;
  const keptRental = subtotalCents - Math.round((subtotalCents * refundPct) / 100);
  const keptServiceFee = serviceFeeCents - Math.round((serviceFeeCents * refundPct) / 100);
  const feeCents = keptRental + keptServiceFee;
  const hostShareCents = Math.round(
    ((keptRental * settings.cancellation.guestCancellationHostSharePct) / 100) *
      (1 - commissionRate(booking)),
  );
  return {
    kind: 'GUEST_CANCELLATION',
    refundCents: totalCents - feeCents,
    feeCents,
    hostShareCents,
    hostFeeCents: 0,
    refundPct,
    hoursBeforeStart: Math.max(0, Math.floor(hours)),
  };
}

export function hostCancellation(
  booking: PricedBooking,
  settings: Pick<PlatformSettings, 'cancellation'>,
  now = new Date(),
): CancellationOutcome {
  return {
    kind: 'HOST_CANCELLATION',
    refundCents: booking.price.totalCents,
    feeCents: 0,
    hostShareCents: 0,
    hostFeeCents: settings.cancellation.hostCancellationFeeCents,
    refundPct: 100,
    hoursBeforeStart: Math.max(0, Math.floor(hoursBefore(booking, now))),
  };
}

/** Nothing was charged yet: an abandoned checkout or a withdrawn request. */
export function noCharge(
  kind: 'ABANDON_CHECKOUT' | 'WITHDRAW_REQUEST',
  booking: PricedBooking,
  now = new Date(),
): CancellationOutcome {
  return {
    kind,
    refundCents: 0,
    feeCents: 0,
    hostShareCents: 0,
    hostFeeCents: 0,
    refundPct: 100,
    hoursBeforeStart: Math.max(0, Math.floor(hoursBefore(booking, now))),
  };
}

/** A platform cancellation (e.g. a vehicle suspended): a full refund, and no Host fee unless at fault. */
export function platformCancellation(booking: PricedBooking, now = new Date()): CancellationOutcome {
  return {
    kind: 'PLATFORM_CANCELLATION',
    refundCents: booking.price.totalCents,
    feeCents: 0,
    hostShareCents: 0,
    hostFeeCents: 0,
    refundPct: 100,
    hoursBeforeStart: Math.max(0, Math.floor(hoursBefore(booking, now))),
  };
}
