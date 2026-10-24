import type { Faq } from '../../src/modules/help/faq.model.js';

type SeedFaq = Omit<Faq, 'createdAt' | 'updatedAt'>;

/**
 * Draft FAQs, written by the team and approved by the client (plan §16, item 18). The first five are the
 * homepage FAQ section, word for word from the frontend. Claims stay general until fees, protection and
 * eligibility are confirmed (plan §16).
 */
export const FAQS: SeedFaq[] = [
  {
    question: 'How is Rento Vroom different from a rental company?',
    answer:
      'Every car belongs to a local host, not a rental fleet. You get a wider choice, from city hatchbacks to family SUVs and EVs, and you can often collect nearby or have the car delivered.',
    category: 'Getting started',
    audience: 'ALL',
    showOnHome: true,
    order: 1,
  },
  {
    question: 'Who can rent a car?',
    answer:
      'You need a valid driver licence and to complete our verification checks before your first trip. Visitors are welcome: if your overseas licence isn’t in English, bring an International Driving Permit or an approved translation. The full eligibility rules are shown before you book.',
    category: 'Booking',
    audience: 'GUEST',
    showOnHome: true,
    order: 2,
  },
  {
    question: 'What does the price include?',
    answer:
      'Every price is in NZD and includes all mandatory charges. Optional extras, like delivery to your door, are listed separately before you pay.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: true,
    order: 3,
  },
  {
    question: 'How do I list my car?',
    answer:
      'Choose Become a Host, tell us about yourself, then add your car in six guided steps: details, documents, photos, pricing, availability and pickup options. Our team reviews each listing before it goes live.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: true,
    order: 4,
  },
  {
    question: 'What if something goes wrong on a trip?',
    answer:
      'In an emergency, call 111 first. Then report the incident from your trip in the app: you’ll get a case number, and our support team works with both sides using the check-in and check-out records.',
    category: 'Safety',
    audience: 'ALL',
    showOnHome: true,
    order: 5,
  },
  {
    question: 'Which payment methods can I use?',
    answer:
      'Visa, Mastercard and other major credit and debit cards, plus Apple Pay and Google Pay on devices that support them. Card details are handled by our payment provider and never stored on Rento Vroom.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 6,
  },
  {
    question: 'Can I see prices in my own currency?',
    answer:
      'Yes. Choose AUD, USD, EUR or CAD to see an approximate price next to the NZD price. You’re always charged in NZD and your card provider converts it, so the amount on your statement can differ slightly.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 7,
  },
  {
    question: 'Can the car be delivered to me or to the airport?',
    answer:
      'Many hosts deliver to an address or an airport for a fee shown before you book. Look for the Delivery and Airport badges, or filter your search by delivery options.',
    category: 'Booking',
    audience: 'GUEST',
    showOnHome: false,
    order: 8,
  },
  {
    question: 'Can I cancel a booking?',
    answer:
      'Yes. Each listing shows its cancellation policy before you book, and you’ll see exactly what would be refunded before you confirm a cancellation. The policy’s refund is of the rental and the service fee; any delivery fee and protection are always refunded in full.',
    category: 'Booking',
    audience: 'ALL',
    showOnHome: false,
    order: 9,
  },
  {
    question: 'What happens at pickup and return?',
    answer:
      'You and the host complete a quick photo check-in: photos of the car, the odometer and the fuel or battery level. You repeat it when you return the car, so both of you have a timestamped record of its condition.',
    category: 'Trips',
    audience: 'ALL',
    showOnHome: false,
    order: 10,
  },
  {
    question: 'Who can list a car?',
    answer:
      'Hosts verify their identity and list a car that’s registered and has a current WOF (or CoF). If you’re not the registered owner, you’ll need the owner’s written consent.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 11,
  },
  {
    question: 'When do hosts get paid?',
    answer:
      'Your earnings for a trip are released after the trip starts and paid to your New Zealand bank account. Your dashboard shows upcoming and paid payouts, and any deductions.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 12,
  },
  {
    question: 'What is Rento Vroom?',
    answer:
      'Rento Vroom is a New Zealand marketplace where local people share their cars. Guests book a car for the dates they need, and Hosts earn when they aren’t using theirs.',
    category: 'Getting started',
    audience: 'ALL',
    showOnHome: false,
    order: 13,
  },
  {
    question: 'How do I book a car?',
    answer:
      'Search by place and dates, compare cars, then book in a few steps. Instant Book cars are confirmed as soon as your payment goes through. For other cars you send a request, and the Host has 24 hours to accept.',
    category: 'Getting started',
    audience: 'GUEST',
    showOnHome: false,
    order: 14,
  },
  {
    question: 'Do I need an account to browse?',
    answer:
      'No. You can search and compare cars without an account. You create one when you book or apply to host.',
    category: 'Getting started',
    audience: 'ALL',
    showOnHome: false,
    order: 15,
  },
  {
    question: 'How do I create an account and verify it?',
    answer:
      'Sign up with your email, confirm the link we send, and enter the code we text to your mobile. Before your first trip, or when you apply to host, you also complete a quick ID document and selfie check.',
    category: 'Account',
    audience: 'ALL',
    showOnHome: false,
    order: 16,
  },
  {
    question: 'Why do you check my identity?',
    answer:
      'Checking identity keeps Guests and Hosts safe and helps us prevent fraud. Most checks finish within minutes, and if one needs a manual review we let you know by email.',
    category: 'Account',
    audience: 'ALL',
    showOnHome: false,
    order: 17,
  },
  {
    question: 'I’m a visitor with an overseas licence. Can I rent?',
    answer:
      'Visitors are welcome if their licence is one we accept. If it isn’t in English, you also need an International Driving Permit or an approved translation, and you should carry both while driving.',
    category: 'Account',
    audience: 'GUEST',
    showOnHome: false,
    order: 19,
  },
  {
    question: 'What happens after I send a request?',
    answer:
      'Your card is authorised and the Host has 24 hours to accept. If they accept, your booking is confirmed. If they decline or don’t answer, the authorisation is released and you aren’t charged.',
    category: 'Booking',
    audience: 'GUEST',
    showOnHome: false,
    order: 20,
  },
  {
    question: 'Can I book for someone else, or add another driver?',
    answer:
      'Each booking has one driver: the Guest who booked, who must be the person driving. Other people shouldn’t drive the car.',
    category: 'Booking',
    audience: 'GUEST',
    showOnHome: false,
    order: 21,
  },
  {
    question: 'Where do I collect the car?',
    answer:
      'Each listing shows its pickup location, and some Hosts offer delivery to you or to the airport for an extra charge shown before you pay. After you book, you’ll see the pickup details and the Host’s contact number.',
    category: 'Booking',
    audience: 'GUEST',
    showOnHome: false,
    order: 22,
  },
  {
    question: 'How do I pay?',
    answer:
      'You pay by card, Apple Pay or Google Pay. Payments are processed securely by Stripe, and we don’t store your full card number.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 23,
  },
  {
    question: 'Why was my card charged in NZD?',
    answer:
      'Every price is in New Zealand dollars. If you view approximate prices in another currency, you’re still charged in NZD and your card provider converts the amount, so your statement can differ slightly.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 24,
  },
  {
    question: 'What fees will I see?',
    answer:
      'Before you pay you’ll see the rental, the service fee, your protection plan and any optional extras, with the GST included and the total in NZD. Fees and rates can change, so always check the amounts at checkout.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 25,
  },
  {
    question: 'Can I get a receipt?',
    answer:
      'Yes. Your receipt is on the trip page, with every charge itemised. Ask our support team if something doesn’t look right.',
    category: 'Payments',
    audience: 'GUEST',
    showOnHome: false,
    order: 26,
  },
  {
    question: 'How do I cancel a booking?',
    answer:
      'Open the trip and choose Cancel. You’ll see exactly what will be refunded before you confirm. A request the Host hasn’t answered yet can be withdrawn at no cost.',
    category: 'Cancellations and refunds',
    audience: 'GUEST',
    showOnHome: false,
    order: 27,
  },
  {
    question: 'How much will I be refunded if I cancel?',
    answer:
      'It depends on the cancellation policy on the listing and how long before pickup you cancel. The listing shows its policy before you book, and your booking keeps that policy even if the Host changes it later.',
    category: 'Cancellations and refunds',
    audience: 'GUEST',
    showOnHome: false,
    order: 28,
  },
  {
    question: 'What if the Host cancels?',
    answer:
      'If a Host cancels a confirmed booking, you get a full refund, and our team can help you find another car.',
    category: 'Cancellations and refunds',
    audience: 'GUEST',
    showOnHome: false,
    order: 29,
  },
  {
    question: 'How long does a refund take?',
    answer: 'Refunds go back to the card you paid with. How long they take to appear depends on your bank.',
    category: 'Cancellations and refunds',
    audience: 'GUEST',
    showOnHome: false,
    order: 30,
  },
  {
    question: 'What happens at pickup?',
    answer:
      'Every trip starts with a photo check in the app. You and the Host take photos of the car, record the odometer and fuel or battery level, and mark any existing damage.',
    category: 'Trips',
    audience: 'GUEST',
    showOnHome: false,
    order: 31,
  },
  {
    question: 'What do I need to do when I return the car?',
    answer:
      'Return it at the agreed time and place with the fuel or charge level the listing asks for, then repeat the photo check with the Host. If the Host isn’t there, you take the photos and they confirm them later.',
    category: 'Trips',
    audience: 'GUEST',
    showOnHome: false,
    order: 32,
  },
  {
    question: 'What if I’m going to be late?',
    answer:
      'Message your Host straight away. A short grace period applies, after which we remind you and tell the Host. A late return can lead to a late-return charge under the Guest Agreement.',
    category: 'Trips',
    audience: 'GUEST',
    showOnHome: false,
    order: 33,
  },
  {
    question: 'Are there distance, fuel or cleaning rules?',
    answer:
      'Each listing sets its own distance limit, fuel or charge policy and cleanliness expectations. They’re shown before you book, and extra charges can be added after a trip with the reason and evidence.',
    category: 'Trips',
    audience: 'GUEST',
    showOnHome: false,
    order: 34,
  },
  {
    question: 'What protection is included in my booking?',
    answer:
      'Every booking includes a protection plan, and you can choose a higher level at checkout. Each plan shows its daily price and the most you would pay towards a covered claim (the excess).',
    category: 'Insurance and protection',
    audience: 'GUEST',
    showOnHome: false,
    order: 35,
  },
  {
    question: 'What does the excess mean?',
    answer:
      'The excess is the most you would pay towards a covered claim. A plan with a lower excess costs more per day. The amounts are shown on the listing and at checkout.',
    category: 'Insurance and protection',
    audience: 'GUEST',
    showOnHome: false,
    order: 36,
  },
  {
    question: 'What should I do after an accident or damage?',
    answer:
      'In an emergency call 111 first. When everyone is safe, take photos, then open the trip and choose Report an incident. You’ll get a case number and our support team keeps both sides updated.',
    category: 'Accidents and damage',
    audience: 'ALL',
    showOnHome: false,
    order: 37,
  },
  {
    question: 'What if the car breaks down?',
    answer:
      'Report it from the trip as soon as it’s safe, and use the roadside assistance details shown with your protection plan where they’re available. Our team will help both sides.',
    category: 'Accidents and damage',
    audience: 'ALL',
    showOnHome: false,
    order: 38,
  },
  {
    question: 'How are damage claims decided?',
    answer:
      'Our team looks at the check-in and check-out photos, messages and any other evidence from both sides, and tells you what it decided and why. Photos at pickup and return are the best protection for everyone.',
    category: 'Accidents and damage',
    audience: 'ALL',
    showOnHome: false,
    order: 39,
  },
  {
    question: 'Do I have to pay a security deposit?',
    answer:
      'Rento Vroom doesn’t currently hold a security deposit on your card. If that changes, you’ll see the amount before you book.',
    category: 'Security deposits',
    audience: 'GUEST',
    showOnHome: false,
    order: 40,
  },
  {
    question: 'What documents do I need to list my car?',
    answer:
      'We ask for the car’s registration, a current WOF (or CoF where needed), your insurance details and photos from the required angles. If you’re not the registered owner, you need the owner’s written consent.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 42,
  },
  {
    question: 'Can I control when my car is available?',
    answer:
      'Yes. You choose the daily price, discounts, the dates it’s available and where Guests collect it. You can block dates or pause the listing at any time.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 43,
  },
  {
    question: 'Can I choose my cancellation policy?',
    answer:
      'You can pick from the cancellation policies we offer for each listing. Guests see your choice before they book.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 44,
  },
  {
    question: 'How much will I earn?',
    answer:
      'You receive the rental price less the platform’s commission, which is shown in your dashboard. The Become a Host page has an earnings estimator, and it’s only an estimate.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 45,
  },
  {
    question: 'What happens if a Guest damages my car?',
    answer:
      'Report it from the booking as soon as you find it, with your check-in and check-out photos. Our team reviews the case and tells you what it decided and why.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 46,
  },
  {
    question: 'What if I need to cancel a booking?',
    answer:
      'Cancelling a confirmed booking gives the Guest a full refund, and repeated cancellations affect your standing as a Host. Block dates in your calendar to avoid it.',
    category: 'Hosting',
    audience: 'HOST',
    showOnHome: false,
    order: 47,
  },
  {
    question: 'How do I contact support?',
    answer:
      'Use the contact form on the Contact us page, or open a case from a trip. You’ll get a reference number straight away and our team replies by email.',
    category: 'Support and disputes',
    audience: 'ALL',
    showOnHome: false,
    order: 48,
  },
  {
    question: 'What if I disagree with a charge or a decision?',
    answer:
      'Contact us with your booking or case reference and any evidence, such as photos or messages. Our team will review it and tell you the outcome.',
    category: 'Support and disputes',
    audience: 'ALL',
    showOnHome: false,
    order: 49,
  },
];
