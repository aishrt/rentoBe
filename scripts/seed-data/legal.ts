import type { LegalContent } from '../../src/modules/cms/cms-block.model.js';
import { AGREEMENT_VERSIONS } from '../../src/modules/users/agreements.js';

/**
 * Draft legal pages (plan §9, Days 3–5). Plain-English drafts that describe how Rento Vroom works today,
 * written for the client's NZ legal adviser to review and replace (plan §16, item 11). They are not legal
 * advice. Numbers (fees, refund tiers, excess amounts) are not written here: the pages show or point to the
 * live figures. A rule the business hasn't decided says REQUIRES_BUSINESS_APPROVAL (decisions D1–D20 in
 * POLICY_BUSINESS_DECISIONS.md). The versions below are unchanged on purpose: a new version makes every
 * user accept again, so that waits for the adviser's text (D1).
 */

const DRAFT_NOTE =
  '*Draft for legal review. This document describes how Rento Vroom works today and has not yet been reviewed by a New Zealand lawyer. Items marked REQUIRES_BUSINESS_APPROVAL are decisions the business has not made yet.*';

const TERMS = `# Terms & Conditions

${DRAFT_NOTE}

## 1. About Rento Vroom

Rento Vroom is an online marketplace in New Zealand. It lets people who own cars ("Hosts") offer them to people who want to rent them ("Guests"). These terms apply to everyone who uses our website and app.

**REQUIRES_BUSINESS_APPROVAL (D14):** the registered company name, address and NZBN of the company that operates Rento Vroom.

**REQUIRES_BUSINESS_APPROVAL (D1):** whether Rento Vroom is the rental provider, or only a platform that connects Hosts and Guests who contract with each other. This changes who is responsible for the car and the rental, and needs legal advice.

## 2. Your account

- You must be at least 18 to hold an account, and meet the age and licence rules shown before you book to drive.
- Give us true details and keep them up to date. Keep your password private and tell us if you think someone else has used your account.
- We check identity, phone, email, driver licences and vehicle documents. We may ask for more information at any time.
- We may refuse, suspend or close an account where we reasonably think it is needed to keep members safe or to follow the law.

## 3. Bookings

- A Guest books a car for set dates. Some cars are confirmed straight away (Instant Book). For others the Guest sends a request, the Host has 24 hours to accept, and the Guest's card is only charged if they accept.
- The price, fees and any protection plan are shown before you pay. Prices are in New Zealand dollars (NZD) and include GST where it applies.
- Each booking keeps the listing's terms as they were when it was booked.
- The [Guest Agreement](/guest-agreement) and [Host Agreement](/host-agreement) set out each side's responsibilities.

## 4. Payments and fees

Payments are processed by Stripe. We charge a service fee to Guests and take a commission from Hosts. The rates are shown when you book or list and in the [payment and fees policy](/payment-and-fees). A Host is paid out as described in the Host Agreement.

## 5. Cancellations and refunds

Guest and Host cancellations are handled under the [Cancellation Policy](/cancellation-policy). Refunds go back to the original payment method.

## 6. Protection and insurance

Each booking includes a protection plan chosen by the Guest. The plan's daily price and excess are shown before you pay. **REQUIRES_BUSINESS_APPROVAL (D2):** the insurer's name, what each plan covers and excludes, and how claims are made. Until then, nothing on this website is a promise that a particular loss will be covered.

## 7. Using a car

Guests must use the car lawfully and as the listing allows. Hosts must provide a safe, roadworthy car with a current registration and WOF or CoF. Use of the car must follow the Guest Agreement.

## 8. Accidents, damage and disputes

Report any accident, damage or breakdown through the app as soon as it is safe. We review the evidence from both sides, such as check-in and check-out photos and messages, and tell you our decision. Contact us if you disagree.

## 9. Content and reviews

You are responsible for what you post, including photos, listings, messages and reviews, and you must have the right to post it. You give us permission to display it on Rento Vroom. Reviews are checked before they are published. We may remove content that breaks the [community guidelines](/community-guidelines) or the law.

## 10. Our responsibilities and limits

**REQUIRES_BUSINESS_APPROVAL (D1):** the limits on our liability, and any indemnities, need to be written by a NZ lawyer. Nothing in these terms is meant to limit rights you have under New Zealand law that cannot be excluded, including the Consumer Guarantees Act 1993 and the Fair Trading Act 1986 where they apply.

## 11. Ending your account

You can close your account at any time, once any open bookings and charges are settled. We may suspend or close an account for serious or repeated breaches of these terms, and will tell you why where we can.

## 12. Changes to these terms

We may update these terms. We will show the date of the latest version, and tell you about material changes before they apply, and ask you to accept them again where the law or the change needs it.

## 13. Law and contact

**REQUIRES_BUSINESS_APPROVAL (D1):** governing law and how disputes are resolved. New Zealand law is expected to apply.

Questions: [contact us](/contact).`;

const PRIVACY = `# Privacy Policy

${DRAFT_NOTE}

This policy explains what personal information Rento Vroom collects, why, who sees it and your choices. We aim to follow the Privacy Act 2020. **REQUIRES_BUSINESS_APPROVAL (D1):** a NZ lawyer must review this before it is final.

## 1. Who we are

Rento Vroom operates the website and app. **REQUIRES_BUSINESS_APPROVAL (D14):** the registered company name and address. **REQUIRES_BUSINESS_APPROVAL (D13):** the Privacy Officer's name and contact details.

## 2. What we collect

- **Account details:** name, email, mobile number, password (stored securely), photo, date of birth and address where needed.
- **Verification:** identity document images and a selfie, and driver licence details, checked through our identity provider and by our staff.
- **Hosts:** vehicle details, registration, WOF or CoF, insurance details, photos, pickup locations and bank details for payouts.
- **Bookings and trips:** dates, locations, messages, check-in and check-out photos, odometer and fuel readings, reviews, incident reports and support cases.
- **Payments:** handled by Stripe. We see the last digits and type of a card, not the full card number.
- **Technical data:** device and browser information, IP address and how the site is used, so we can run it securely.

## 3. Why we use it

- To run accounts, verify identity and eligibility, and make bookings work.
- To take payments and pay Hosts.
- To keep members safe, prevent fraud and check suspicious activity.
- To handle claims, incidents, disputes and support requests.
- To send service messages by email, SMS and in the app, such as booking confirmations and reminders. Marketing messages are only sent where you have agreed, and you can unsubscribe.
- To meet legal duties, including tax and accounting records.

## 4. Who we share it with

- **The other party to a booking:** a Guest and Host see what they need to complete a trip, such as names, photos, contact details for the trip and pickup details.
- **Service providers** that run Rento Vroom for us, including Stripe (payments and identity checks), cloud hosting, email and SMS delivery, and maps and address search. They may handle information outside New Zealand. **REQUIRES_BUSINESS_APPROVAL (D1):** the lawyer must confirm the overseas disclosure wording (Privacy Act information privacy principle 12).
- **Insurers and professional advisers**, where needed for a claim.
- **Authorities** such as the Police, NZTA or the courts, where the law requires it or to prevent serious harm.

We do not sell your personal information.

## 5. How long we keep it

We keep information only as long as we need it for these purposes or the law requires. **REQUIRES_BUSINESS_APPROVAL (D1):** the final retention periods. The proposals are: financial records at least 7 years, identity document images for a short period after checks finish, trip records a few years, and the audit log at least 7 years.

## 6. Security

We use measures such as encrypted connections, access controls and logs of staff activity. No system is completely secure. **REQUIRES_BUSINESS_APPROVAL (D1):** the lawyer must confirm the wording on notifiable privacy breaches.

## 7. Your rights

You can ask to see the personal information we hold about you, and to correct it. You can also close your account. [Contact us](/contact) and we will respond within the time the Privacy Act requires. If you are unhappy with our response, you can complain to the Office of the Privacy Commissioner.

## 8. Cookies

We use cookies and similar technology for sign-in, security and to remember your choices. **REQUIRES_BUSINESS_APPROVAL (D1):** whether any analytics or advertising cookies are used, and the matching notice.

## 9. Changes

We will update this policy when our practices change and show the date of the latest version.`;

const CANCELLATION = `# Cancellation Policy

${DRAFT_NOTE}

This policy sets what happens to a booking and its payment when a Guest or a Host cancels. The cancellation tiers in force are shown at the top of this page. They are set in our booking system and can change, but a booking always keeps the tier it was booked with.

## 1. Cancellation tiers

Each listing uses one tier, and it is shown on the listing before you book. A tier sets how much of the rental is refunded, depending on how long before pickup the Guest cancels.

## 2. When a Guest cancels

- Open the trip and choose **Cancel**. You see the exact refund before you confirm.
- The tier's refund applies to the rental and the service fee. Delivery fees and protection are refunded in full.
- A request that the Host has not answered yet can be withdrawn at no cost.
- Refunds go back to the card used. How long they take to arrive depends on your bank.

## 3. When a Host cancels

If a Host cancels a confirmed booking, the Guest gets a full refund and we help them look for another car. Repeated cancellations affect a Host's standing, and a Host may owe a cancellation fee. **REQUIRES_BUSINESS_APPROVAL (D15):** the amount of any Host cancellation fee. It is currently set to nothing.

## 4. When a Host does not respond, declines or is a no-show

If a Host declines a request or does not answer within 24 hours, the Guest's card is not charged. **REQUIRES_BUSINESS_APPROVAL (D12):** what happens when a Host does not turn up at pickup.

## 5. Returning early or shortening a trip

Unused days are not refunded when a car is returned early. **REQUIRES_BUSINESS_APPROVAL (D17):** whether trip changes and early-return requests are offered.

## 6. If a Guest cancels and the Host keeps part of the rental

The kept amount is shared with the Host like any other rental, after our commission.

## 7. Last-minute bookings

**REQUIRES_BUSINESS_APPROVAL (D16):** whether a short free cancellation window applies after a booking made close to pickup.

## 8. Problems that are not cancellations

If something goes wrong on a trip, see the [refund policy](/refund-policy) and [damage and claims](/damage-and-claims), or [contact us](/contact).`;

const GUEST = `# Guest Agreement

${DRAFT_NOTE}

This agreement applies when you book a car on Rento Vroom as a Guest. It sits alongside the [Terms & Conditions](/terms).

## 1. Who can drive

- You must meet the age and licence rules shown before you book: see [driver eligibility](/driver-eligibility).
- You must hold a valid licence for the whole trip, and be the only driver. **REQUIRES_BUSINESS_APPROVAL (D11):** confirm the one-driver rule, or add a process for additional drivers.
- Tell us straight away if your licence is suspended, restricted or changes.

## 2. Before and at pickup

- Take the photo check at pickup with the Host, and record the odometer and fuel or battery level. Mark any existing damage.
- Check the car is safe to drive. Do not drive it if you think it is not.

## 3. Using the car

You must use the car lawfully and with care. Do not use it for the things listed in [prohibited uses](/prohibited-uses). **REQUIRES_BUSINESS_APPROVAL (D9):** the final list of prohibited uses.

## 4. Fuel, distance and cleaning

Return the car with the fuel or charge level and cleanliness the listing requires, and within any distance limit. Extra charges for distance, fuel or cleaning can be added after a trip, with the reason and evidence. **REQUIRES_BUSINESS_APPROVAL (D4):** the fuel and cleaning charge rules.

## 5. Tolls, fines and tickets

You, the Guest, pay all tolls, traffic fines, parking tickets and infringement notices incurred while the car is booked to you, from pickup to check-out. If a notice reaches the Host, the Host reports it with the notice attached. We may give the issuing authority your driver details so the notice is redirected to you, or charge the amount of the notice to your card on file, with the notice as evidence. You can reply on the case. **Needs NZ legal review:** the final clause wording.

## 6. Returning the car

Return the car at the agreed time and place and take the check-out photos with the Host. If you are going to be late, tell the Host. A late return can lead to a late-return charge. **REQUIRES_BUSINESS_APPROVAL (D3):** the amount or rate. See [late returns and charges](/late-returns-and-charges).

## 7. Protection and your excess

Your booking includes the protection plan you chose. The plan sets the most you pay towards a covered claim (the excess). **REQUIRES_BUSINESS_APPROVAL (D2):** what each plan covers and excludes, and when cover does not apply, for example after a breach of this agreement.

## 8. Accidents and damage

Call 111 in an emergency. Report any accident, damage or breakdown through the app as soon as it is safe, take photos, and do not accept blame or agree payment at the scene. See [damage and claims](/damage-and-claims). **REQUIRES_BUSINESS_APPROVAL (D6):** who pays damage below the excess or not covered.

## 9. Payments and deposit

You pay the amounts shown at booking and any charges added after the trip under this agreement. No security deposit is currently held. See [security deposit](/security-deposit). **REQUIRES_BUSINESS_APPROVAL (D5).**

## 10. Cancelling

See the [Cancellation Policy](/cancellation-policy).

## 11. Breaches

If you break this agreement we may end a rental, add charges, and suspend or close your account. Cover may not apply.

## 12. Changes

We may update this agreement and will show the date of the latest version.`;

const HOST = `# Host Agreement

${DRAFT_NOTE}

This agreement applies when you list a car on Rento Vroom as a Host. It sits alongside the [Terms & Conditions](/terms).

## 1. Becoming a Host

- You must be at least 18, verify your identity, and apply to host. We may approve or refuse an application.
- You must own the car, or have the owner's written consent to list it.
- Our team checks each listing before it goes live. We may pause or remove a listing that is out of date, unsafe or not as described.

## 2. Your car

- It must be registered, with a current WOF or CoF where needed, and roadworthy. See [vehicle eligibility](/vehicle-eligibility).
- Keep your registration, WOF or CoF, RUC and insurance details up to date. **REQUIRES_BUSINESS_APPROVAL (D2):** the insurance a Host must hold for their own car, and how it works with the Guest's protection plan.
- Describe the car accurately, with clear and current photos. Say if it has damage or limits.
- Hand the car over clean, safe and with the fuel or charge level the listing states.

## 3. Your listing and prices

You set the daily price, discounts, availability, pickup and delivery options and (from the tiers we offer) your cancellation policy. Each booking keeps the terms it was made with.

## 4. Fees and payouts

We take a commission from each rental. The rate is shown on your dashboard and in the [payment and fees policy](/payment-and-fees). Your share is released after the trip starts, once check-in is done, and paid to your New Zealand bank account. A payout can be held while an incident or payment dispute on the trip is open. **REQUIRES_BUSINESS_APPROVAL (D15):** confirm the commission and payout timing. You are responsible for your own tax, including GST if you are registered. We cannot give you tax advice.

## 5. Trips

Take the photo check at pickup and return with the Guest and record the odometer and fuel or battery level. These photos are the main evidence for any claim.

## 6. Cancelling a booking

If you cancel a confirmed booking the Guest gets a full refund. Repeated cancellations affect your standing as a Host and may lead to restrictions. **REQUIRES_BUSINESS_APPROVAL (D15):** any cancellation fee.

## 7. Damage, claims and disputes

Report damage through the app as soon as you find it, with your photos. We review the evidence from both sides and tell you what we decided and why. **REQUIRES_BUSINESS_APPROVAL (D19):** the evidence a Host must provide and any penalty for an invalid claim. See [damage and claims](/damage-and-claims).

## 8. Behaviour

Follow the [community guidelines](/community-guidelines). Do not discriminate, and keep conversations on Rento Vroom. Do not ask Guests to pay outside the platform.

## 9. Ending your hosting

You can pause or remove a listing at any time, once existing bookings are looked after. We may suspend or close your account for serious or repeated breaches.

## 10. Changes

We may update this agreement and will show the date of the latest version.`;

/** The text the first draft replaced; a seeded page is only updated while it still has it. */
export const PLACEHOLDER_MARKER = 'This is placeholder text';

export const LEGAL_PAGES: { key: string; version: string; content: LegalContent }[] = [
  { key: 'legal.terms', version: AGREEMENT_VERSIONS.TERMS, title: 'Terms & Conditions', markdown: TERMS },
  { key: 'legal.privacy', version: AGREEMENT_VERSIONS.PRIVACY, title: 'Privacy Policy', markdown: PRIVACY },
  {
    key: 'legal.guest-agreement',
    version: AGREEMENT_VERSIONS.GUEST,
    title: 'Guest Agreement',
    markdown: GUEST,
  },
  { key: 'legal.host-agreement', version: AGREEMENT_VERSIONS.HOST, title: 'Host Agreement', markdown: HOST },
  {
    key: 'legal.cancellation-policy',
    version: AGREEMENT_VERSIONS.TERMS,
    title: 'Cancellation Policy',
    markdown: CANCELLATION,
  },
].map(({ key, version, title, markdown }) => ({ key, version, content: { title, markdown } }));
