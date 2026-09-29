import { Schema, model } from 'mongoose';

/**
 * The currencies visitors can see prices in besides NZD (plan §12.7). These are estimates only:
 * every charge, refund and payout stays in NZD.
 */
export const DISPLAY_CURRENCIES = ['AUD', 'USD', 'EUR', 'CAD'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

/** The `exchangeRates` collection: one document per reference date. */
export interface ExchangeRate {
  /** The day the source published the rates for, YYYY-MM-DD. */
  date: string;
  /** How much of each currency NZ$1 buys. */
  rates: Record<DisplayCurrency, number>;
  source: 'ECB';
  fetchedAt: Date;
}

const exchangeRateSchema = new Schema<ExchangeRate>(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    rates: Object.fromEntries(
      DISPLAY_CURRENCIES.map((currency) => [currency, { type: Number, required: true, min: 0 }]),
    ),
    source: { type: String, enum: ['ECB'], required: true },
    fetchedAt: { type: Date, required: true },
  },
  { collection: 'exchangeRates' },
);

exchangeRateSchema.index({ date: -1 }, { unique: true });

export const ExchangeRateModel = model<ExchangeRate>('ExchangeRate', exchangeRateSchema);
