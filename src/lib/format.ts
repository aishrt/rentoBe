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

/** Whole dollars from cents, e.g. 8900 → "$89" (plan §12.7). */
export const formatNzdFromCents = (cents: number) => nzdFormat.format(Math.round(cents / 100));
