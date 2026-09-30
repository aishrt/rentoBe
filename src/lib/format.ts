import { NZ_TIME_ZONE } from './nz-time.js';
import type { NzAddress } from './model-fields.js';

/*
 * NZ formatters for what the backend writes itself: page tags, emails, PDFs and SMS (plan §2.3). The
 * frontend has the same ones in frontend/src/lib/format.ts.
 */

const nzdFormat = new Intl.NumberFormat('en-NZ', {
  style: 'currency',
  currency: 'NZD',
  currencyDisplay: 'narrowSymbol',
  maximumFractionDigits: 0,
});

const nzdCentsFormat = new Intl.NumberFormat('en-NZ', {
  style: 'currency',
  currency: 'NZD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole dollars from cents, e.g. 8900 → "$89" (plan §12.7). */
export const formatNzdFromCents = (cents: number) => nzdFormat.format(Math.round(cents / 100));

/** Dollars and cents, for receipts and price breakdowns: 8950 → "$89.50", -4200 → "-$42.00". */
export const formatNzdExact = (cents: number) => nzdCentsFormat.format(cents / 100);

const dateFormat = new Intl.DateTimeFormat('en-NZ', {
  timeZone: NZ_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-NZ', {
  timeZone: NZ_TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** "12/10/2026" in NZ time (plan §3: DD/MM/YYYY). */
export const formatNzDate = (instant: Date) => dateFormat.format(instant);

/** "Mon, 12 Oct 2026, 10:00 am" in NZ time, for emails and SMS. */
export const formatNzDateTime = (instant: Date) =>
  dateTimeFormat.format(instant).replace(/\b(AM|PM)\b/, (period) => period.toLowerCase());

/** One structured NZ address in NZ order (plan §3): "12 Queen Street, Auckland Central, Auckland 1010". */
export function formatNzAddress(
  address: Pick<NzAddress, 'unit' | 'streetNumber' | 'street' | 'suburb' | 'city' | 'postcode'>,
): string {
  const number = [address.unit, address.streetNumber].filter(Boolean).join('/');
  const street = [number, address.street].filter(Boolean).join(' ');
  return [street, address.suburb, `${address.city} ${address.postcode}`.trim()].filter(Boolean).join(', ');
}
