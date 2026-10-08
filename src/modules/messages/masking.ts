/*
 * Contact details in messages (plan §3, Key rules; spec §13, §22): until a booking is confirmed, phone
 * numbers, email addresses and links typed into messages are hidden, matching what each party can see.
 * The message is stored as written, so they show once the booking is confirmed.
 */

export const MASKED = '[contact details hidden until the booking is confirmed]';

const EMAIL = /[\w.+-]+\s*(?:@|\(at\)|\[at\])\s*[\w-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[\w-]+)+/gi;
const LINK =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|nz|net|org|io|me|co|au|app|link|ly)\b(?:\/\S*)?/gi;
// Seven or more digits, allowing spaces, dots, dashes, brackets and a leading +, as people type numbers.
const PHONE = /(?:\+|\b)\d(?:[\s.\-()]*\d){6,}/g;

/** The text with every phone number, email address and link replaced. */
export function maskContactDetails(text: string): string {
  return text.replace(EMAIL, MASKED).replace(LINK, MASKED).replace(PHONE, MASKED);
}
