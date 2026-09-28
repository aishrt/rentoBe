import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const TEXTABLE = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE']);

/**
 * A mobile number as typed (021 123 4567, +61 412 345 678) in E.164, or null if it isn't a valid
 * number that can receive texts. New Zealand is assumed when there's no country code (plan §6.1).
 */
export function toMobileE164(input: string): string | null {
  const phone = parsePhoneNumberFromString(input.trim(), 'NZ');
  if (!phone?.isValid()) return null;
  const type = phone.getType();
  if (type && !TEXTABLE.has(type)) return null;
  return phone.number;
}
