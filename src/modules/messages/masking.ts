/*
 * Contact details in messages (plan §3, Key rules; spec §13, §22): until a booking is confirmed, phone
 * numbers, email addresses and links typed into messages are hidden, matching what each party can see.
 * The message is stored as written, so they show once the booking is confirmed. Reviews with contact
 * details are held for a moderator by the same rules.
 */

export const MASKED = '[contact details hidden until the booking is confirmed]';

/** Endings that make "name.ending" a web address, in any case: Google.com, Rentovroom.Com, EXAMPLE.COM. */
const TLDS = 'com|nz|net|org|io|me|co|au|app|link|ly|info|biz|kiwi|xyz|online|site|shop|ai|uk|ca|tv';
/** Endings that are also words a sentence can start with, as in "It was great.Me and my wife". */
const WORD_ENDINGS = new Set('me net nz uk au tv ai app info kiwi link online shop site'.split(' '));

// "@" and how people spell it out: "kiri (at) gmail (dot) com", "kiri at gmail dot com".
const AT = String.raw`\s*@\s*|\s*[(\[]\s*at\s*[)\]]\s*|\s+at\s+`;
const DOT = String.raw`\s*\.\s*|\s*[(\[]\s*dot\s*[)\]]\s*|\s+dot\s+`;
const EMAIL = new RegExp(String.raw`[\w.+-]+(?:${AT})[\w-]+(?:(?:${DOT})[\w-]+)+`, 'gi');
const SPELLED_OUT = /[([]\s*at\s*[)\]]|@|\bdot\b/i;
const KNOWN_ENDING = new RegExp(String.raw`\.\s*(?:${TLDS})$`, 'i');
/**
 * Words that come before a plain "at" in a sentence, so aren't the name in an address: "my mate is at
 * uni.ac.nz". The m, s, re, ll, ve and d are what's left of I'm, she's, we're, we'll, I've and I'd.
 */
const NOT_A_MAILBOX = new Set(
  (
    'i me you he him she her it we us they them who am is are was were be been being m s re ll ve d ' +
    'arrive arrives arrived arriving meet meeting met see look looking stay staying stayed live lives ' +
    'living work works working park parked wait waiting pick picked drop dropped leave left get got ' +
    'here there back home up off out not just still only all and or but so then now'
  ).split(' '),
);

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
// The ending can't run on into a word: "Loved it.Co-pilot" isn't a link.
const DOMAIN = new RegExp(String.raw`\b[\w-]+(?:\.[\w-]+)*\.(${TLDS})(?![\w-])(?:\/\S*)?`, 'gi');

/** One word, a dot and another, as in "great.Me" or "home. Me". */
const WORD_DOT_WORD = /^[a-z]+\s*\.\s*[a-z]+$/i;
/** More words follow. */
const CARRIES_ON = /\s+\p{L}/uy;

// A range of 24-hour times (0900-1000) or a date with spaces (02 11 2026) could also be part of a phone
// number split up, so neither is taken with more digits just before or after it.
const NO_DIGITS_BEFORE = String.raw`(?<![\d+][\s._()-]{0,3})`;
const NO_DIGITS_AFTER = String.raw`(?![\s._()-]{0,3}\d)`;
const HHMM = String.raw`(?:[01]\d|2[0-3])[0-5]\d`;
const SPACED_DATE = String.raw`[0-3]?\d\s[0-3]?\d\s(?:19|20)\d\d`;

/**
 * Times and dates, which a phone number pattern would otherwise take: 9.30, 10:00 (and 9.30-10.00),
 * 0900-1000, 12.10.2026, 12/10/26, 2026-10-12 and 02 11 2026. Phone numbers are looked for only in the
 * text between them.
 */
const DATE_OR_TIME = new RegExp(
  '(' +
    [
      String.raw`(?<![\d.:/-])\d{4}[./-]\d{1,2}[./-]\d{1,2}(?!\d|[./-]\d)`,
      String.raw`(?<![\d.:/-])[0-3]?\d[./-][0-3]?\d[./-](?:\d{4}|\d{2})(?!\d|[./-]\d)`,
      String.raw`${NO_DIGITS_BEFORE}${SPACED_DATE}(?:\s?[-–]\s?${SPACED_DATE})?${NO_DIGITS_AFTER}`,
      String.raw`(?<![\d.:])(?:[01]?\d|2[0-3])[.:][0-5]\d(?!\d|[.:]\d)`,
      String.raw`${NO_DIGITS_BEFORE}${HHMM}\s?[-–]\s?${HHMM}${NO_DIGITS_AFTER}`,
    ].join('|') +
    ')',
);

/**
 * Phone numbers as people type them: starting with 0, + or 64, with 8 to 11 digits (up to 15 after a +),
 * which spaces, dots, dashes, underscores or brackets may split up.
 */
const SEP = String.raw`[\s._\-()]{0,3}`;
const PHONE = new RegExp(
  String.raw`(?<![\d+])(?:\+${SEP}\d(?:${SEP}\d){6,14}|\(?0(?:${SEP}\d){7,10}|64(?:${SEP}\d){6,9})(?!\d)`,
  'g',
);

/**
 * A full stop with no space after it, then the next sentence: "It was great.Me and my wife". That's one
 * word, a dot and an ending that's also a word, with more words after it (`end` is where it stops in
 * `text`). In lower case only "me" reads that way, so "kiri.nz is my site" is still a link.
 */
function isNextSentence(address: string, ending: string, text: string, end: number): boolean {
  if (!WORD_DOT_WORD.test(address) || !WORD_ENDINGS.has(ending.toLowerCase())) return false;
  if (ending === ending.toLowerCase() && ending !== 'me') return false;
  CARRIES_ON.lastIndex = end;
  return CARRIES_ON.test(text);
}

/**
 * An email address, or one spelled out. With a plain "at" it has to be spelled out to the end ("dot com")
 * or end like a web address, so "pick up at 9.30" isn't one; and the word before "at" has to be able to
 * be a name, so "my mate is at uni.ac.nz" isn't one either (the web address in it is still hidden).
 */
function isEmail(match: string, text: string, end: number): boolean {
  if (SPELLED_OUT.test(match)) return true;
  if (!KNOWN_ENDING.test(match)) return false;
  const [mailbox = '', domain = ''] = match.split(/\s+at\s+/i);
  const ending = domain.slice(domain.lastIndexOf('.') + 1).trim();
  return !NOT_A_MAILBOX.has(mailbox.toLowerCase()) && !isNextSentence(domain, ending, text, end);
}

/** A web address without http:// or www., unless it's a missing space. In capitals it's one either way. */
const isDomain = (match: string, ending: string, text: string, end: number) =>
  match === match.toUpperCase() || !isNextSentence(match, ending, text, end);

function maskPhones(text: string): string {
  // split() with a capturing group keeps the dates and times, at the odd positions.
  return text
    .split(DATE_OR_TIME)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PHONE, MASKED)))
    .join('');
}

/** The text with every phone number, email address and link replaced. */
export function maskContactDetails(text: string): string {
  const withoutEmails = text.replace(EMAIL, (match, offset: number, whole: string) =>
    isEmail(match, whole, offset + match.length) ? MASKED : match,
  );
  const withoutLinks = withoutEmails
    .replace(LINK, MASKED)
    .replace(DOMAIN, (match, ending: string, offset: number, whole: string) =>
      isDomain(match, ending, whole, offset + match.length) ? MASKED : match,
    );
  return maskPhones(withoutLinks);
}
