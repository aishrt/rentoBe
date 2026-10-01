import { randomInt } from 'node:crypto';

/** Letters and digits that can't be misread over the phone: no 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short reference people can read out, e.g. "RV-7K2Q9M" for a booking or "ST-4HX8PA" for a ticket. */
export function randomRef(prefix: string, length = 6): string {
  let code = '';
  for (let index = 0; index < length; index += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${code}`;
}
