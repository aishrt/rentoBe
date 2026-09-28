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
      'Yes. Choose AUD, USD, EUR, CAD or GBP to see an approximate price next to the NZD price. You’re always charged in NZD and your card provider converts it, so the amount on your statement can differ slightly.',
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
      'Yes. Each listing shows its cancellation policy before you book, and you’ll see exactly what would be refunded before you confirm a cancellation.',
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
];
