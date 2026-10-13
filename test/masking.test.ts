import { describe, expect, it } from 'vitest';
import { MASKED, maskContactDetails } from '../src/modules/messages/masking.js';
import { moderationReason } from '../src/modules/reviews/reviews.service.js';

/* Contact details in messages before a booking is confirmed, and in reviews (plan §3, Key rules). */

describe('maskContactDetails', () => {
  it.each([
    ['Text me on 021 123 4567', `Text me on ${MASKED}`],
    ['or +64 21 123 4567 from Aus', `or ${MASKED} from Aus`],
    ['021_123_4567', MASKED],
    ['Ring 021.123.4567 any time', `Ring ${MASKED} any time`],
    ['021-123-4567', MASKED],
    ['(09) 123 4567 is the landline', `${MASKED} is the landline`],
    ['0800 123 456', MASKED],
    ['64 21 123 4567', MASKED],
    ['+44 7911 123456', MASKED],
    ['call 0211234567.', `call ${MASKED}.`],
  ])('hides the phone number in "%s"', (text, masked) => {
    expect(maskContactDetails(text)).toBe(masked);
  });

  it.each([
    ['kiri@example.co.nz, thanks', `${MASKED}, thanks`],
    ['kiri (at) example (dot) com', MASKED],
    ['kiri [at] example [dot] co [dot] nz', MASKED],
    ['email kiri at gmail dot com', `email ${MASKED}`],
    ['kiri AT gmail DOT com please', `${MASKED} please`],
    ['kiri at gmail.com', MASKED],
    ['name at gmail.com', MASKED],
    ['kiri at gmail.COM', MASKED],
  ])('hides the email address in "%s"', (text, masked) => {
    expect(maskContactDetails(text)).toBe(masked);
  });

  it.each([
    ['see www.example.com', `see ${MASKED}`],
    ['https://x.io/a', MASKED],
    ['book on rentovroom.co.nz', `book on ${MASKED}`],
    ['Google.com has it', `${MASKED} has it`],
    ['Rentovroom.Co.Nz', MASKED],
    ['EXAMPLE.COM', MASKED],
    ['kiri.nz/cars', MASKED],
    ['Rentovroom.Com', MASKED],
    ['kiri.nz is my site', `${MASKED} is my site`],
    ['my site is kiri.me', `my site is ${MASKED}`],
    // "is at" is part of the sentence, not an email address; the web address after it is still hidden.
    ['my mate is at uni.ac.nz', `my mate is at ${MASKED}`],
  ])('hides the link in "%s"', (text, masked) => {
    expect(maskContactDetails(text)).toBe(masked);
  });

  it.each([
    'Pick-up at 10:30 on 12/10/2026, about 45,000 km on the clock.',
    'Can I pick up 9.30-10.00?',
    'Pick up 09.30-10.00 works.',
    'Back on 12.10.2026 at 08.15',
    'Back on 02.10.2026 or 02-10-26',
    'Booked 2026-10-12 to 2026-10-14',
    'Pickup between 0900 - 1000 suits.',
    'Pick up 0900-1000, drop off 1700–1800.',
    'Back on 02 11 2026 at 10.',
    'Staying 02 11 2026 - 05 11 2026.',
    'It was great.Me and my wife loved it.',
    'It was great.me and my wife loved it.',
    'Loved it.NZ is beautiful.',
    'Hana at home. Me and the kids loved it.',
    'Loved it.Co-pilot was happy too.',
    'I’ll arrive at 9.30 tomorrow.',
    'Meet at the airport.Then we drive.',
    'The odometer read 64,512 km and fuel was 0.75 full.',
    'Ref RV-7K2Q9M, $1,250.00 all up.',
  ])('leaves "%s" alone', (text) => {
    expect(maskContactDetails(text)).toBe(text);
  });

  it('still finds a number next to a time', () => {
    expect(maskContactDetails('After 5.30 text 021 123 4567')).toBe(`After 5.30 text ${MASKED}`);
    expect(maskContactDetails('0900-1000, or text 021 123 4567')).toBe(`0900-1000, or text ${MASKED}`);
  });

  it('takes a time range or a date with spaces next to more digits as a phone number', () => {
    expect(maskContactDetails('0211-2345 678')).toBe(MASKED);
    expect(maskContactDetails('call 021 02 11 2026')).toBe(`call ${MASKED}`);
  });

  it('stays quick on a long message built to make the patterns backtrack', () => {
    const messages = [
      'a'.repeat(2000),
      'a.'.repeat(1000),
      '0900 - '.repeat(300),
      'kiri at home.me '.repeat(130),
    ];
    const started = performance.now();
    for (const text of messages) maskContactDetails(text);
    // About 0.1 s; a pattern that backtracks without bound would take far longer.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('reviews held for contact details', () => {
  it('holds a review with an email spelled out, not one with dates and times', () => {
    expect(moderationReason('Great host, email hana at gmail dot com')).toBe(
      'Contains contact details or a link',
    );
    expect(moderationReason('Picked up 9.30 on 12.10.2026, great.Me and the kids loved it')).toBeNull();
  });
});
