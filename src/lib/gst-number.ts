/*
 * NZ GST numbers are IRD numbers: 8 or 9 digits, the last a check digit worked out from the others by Inland
 * Revenue's rule. A typo in one is caught here rather than printed on a Host's statement.
 */

const PRIMARY_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];
const SECONDARY_WEIGHTS = [7, 4, 3, 2, 5, 2, 7, 6];

/** The check digit the first 8 of 9 digits call for with these weights: 10 when they give none. */
function checkDigit(digits: string, weights: number[]): number {
  const remainder = weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11;
  return remainder === 0 ? 0 : 11 - remainder;
}

/**
 * Whether a GST (IRD) number is one Inland Revenue could have issued: between 10-000-000 and 150-000-000,
 * with the right check digit. Hyphens and spaces are ignored; an 8-digit number counts with a leading 0.
 */
export function isValidGstNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{8,9}$/.test(digits)) return false;
  const padded = digits.padStart(9, '0');
  const number = Number(padded);
  if (number < 10_000_000 || number > 150_000_000) return false;
  let check = checkDigit(padded, PRIMARY_WEIGHTS);
  if (check === 10) check = checkDigit(padded, SECONDARY_WEIGHTS);
  return check !== 10 && check === Number(padded[8]);
}
