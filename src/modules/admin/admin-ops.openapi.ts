import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { homeHeroSchema, legalPageSchema, siteFooterSchema } from '../cms/content.schemas.js';
import { removedMessageResponseSchema, removeMessageSchema } from '../messages/messages.schemas.js';
import {
  adminBookingDetailSchema,
  adminBookingsResponseSchema,
  adminDashboardSchema,
  adminDestinationSchema,
  adminDestinationsResponseSchema,
  adminExtraChargesResponseSchema,
  adminFaqSchema,
  adminFaqsResponseSchema,
  adminFeaturedResponseSchema,
  adminFeaturedReviewsSchema,
  adminHelpArticleSchema,
  adminHomeHeroSchema,
  adminHelpArticlesResponseSchema,
  adminJobsResponseSchema,
  adminPaymentsResponseSchema,
  adminPayoutSchema,
  adminPayoutsResponseSchema,
  adminRefundSchema,
  adminRefundsResponseSchema,
  adminReportSchema,
  adminReportsResponseSchema,
  adminSiteFooterSchema,
  adminStatusEditSchema,
  adminUserResponseSchema,
  adminUsersResponseSchema,
  adminVehicleSuspensionSchema,
  auditQuerySchema,
  auditResponseSchema,
  bookingListQuerySchema,
  destinationCreateSchema,
  destinationEditSchema,
  exportQuerySchema,
  extraChargeListQuerySchema,
  faqInputSchema,
  featuredReviewsSchema,
  featuredVehiclesSchema,
  helpArticleInputSchema,
  holdPayoutSchema,
  jobQuerySchema,
  legalPageEditSchema,
  legalPagesResponseSchema,
  overviewQuerySchema,
  paymentListQuerySchema,
  payoutListQuerySchema,
  permissionsSchema,
  platformReportSchema,
  refundListQuerySchema,
  reportRangeSchema,
  resolveReportSchema,
  reviewChoicesResponseSchema,
  riskQueueSchema,
  staffTicketReplySchema,
  staffTicketResponseSchema,
  staffTicketsResponseSchema,
  suspendSchema,
  ticketListQuerySchema,
  ticketUpdateSchema,
  userListQuerySchema,
  vehicleChoicesResponseSchema,
  waiveFeeSchema,
} from './admin-ops.schemas.js';

type Request = NonNullable<RouteConfig['request']>;

interface Operation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  description?: string;
  params?: Request['params'];
  query?: Request['query'];
  body?: z.ZodType;
  /** The 200 (or 201) JSON body; none for 204. */
  response?: z.ZodType;
  created?: boolean;
  errors?: Parameters<typeof errorResponses>;
}

const id = z.object({ id: z.string() });
const ref = z.object({ ref: z.string() });

/** The contract for admin-ops.routes.ts (plan §2.3). Every route needs an active staff account. */
export function registerAdminOpsPaths(registry: OpenAPIRegistry) {
  const add = ({
    method,
    path,
    summary,
    description,
    params,
    query,
    body,
    response,
    created,
    errors,
  }: Operation) =>
    registry.registerPath({
      method,
      path,
      tags: ['Admin'],
      summary,
      ...(description && { description }),
      security: signedIn,
      request: {
        ...(params && { params }),
        ...(query && { query }),
        ...(body && { body: jsonBody(body) }),
      },
      responses: {
        ...(response
          ? { [created ? 201 : 200]: jsonResponse('Done', response) }
          : { 204: { description: 'Done' } }),
        ...errorResponses(...(errors ?? [401, 403, 404])),
      },
    });

  add({
    method: 'get',
    path: '/admin/dashboard',
    summary: 'Staff: the overview figures for a date range, and the queues waiting',
    query: overviewQuerySchema,
    response: adminDashboardSchema,
    errors: [400, 401, 403],
  });

  // Users
  add({
    method: 'get',
    path: '/admin/users',
    summary: 'Staff: search users',
    query: userListQuerySchema,
    response: adminUsersResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/users/{id}',
    summary: 'Staff: a user’s record',
    params: id,
    response: adminUserResponseSchema,
  });
  add({
    method: 'post',
    path: '/admin/users/{id}/suspend',
    summary: 'Staff: suspend a user',
    description:
      'They’re signed out and can’t sign in, their listings are hidden and their payouts held. Their upcoming bookings are returned for staff to keep or cancel (plan §8.2).',
    params: id,
    body: suspendSchema,
    response: adminUserResponseSchema,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/users/{id}/unsuspend',
    summary: 'Staff: lift a suspension',
    description: 'Their listings return to search and held payouts are sent.',
    params: id,
    response: adminUserResponseSchema,
    errors: [401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/users/{id}/risk-flags/{flagId}/clear',
    summary: 'Staff: clear a risk flag after looking into it',
    params: z.object({ id: z.string(), flagId: z.string() }),
    response: adminUserResponseSchema,
  });
  add({
    method: 'post',
    path: '/admin/users/{id}/close',
    summary: 'Admin: close and anonymise an account on request',
    description:
      'Refused while a trip, booking, incident, unpaid charge or payout is under way. Bookings, payments and audit records stay for the periods the law requires (plan §8.2, §14).',
    params: id,
    response: adminUserResponseSchema,
    errors: [401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/users/{id}/waive-host-fee',
    summary: 'Admin: waive Host cancellation fees owed',
    description: 'Some or all of what the Host owes; written to the audit log (plan §8.1, item 10).',
    params: id,
    body: waiveFeeSchema,
    response: adminUserResponseSchema,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/staff/{id}/permissions',
    summary: 'Admin: give or take a support member’s refunds permission',
    params: id,
    body: permissionsSchema,
    response: adminUserResponseSchema,
    errors: [400, 401, 403, 404],
  });
  add({
    method: 'get',
    path: '/admin/risk',
    summary: 'Staff: people with risk flags to review',
    response: riskQueueSchema,
    errors: [401, 403],
  });

  // Bookings and cars
  add({
    method: 'get',
    path: '/admin/bookings',
    summary: 'Staff: search bookings',
    query: bookingListQuerySchema,
    response: adminBookingsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/bookings/{id}',
    summary: 'Staff: a booking’s whole record',
    description:
      'By id or reference: the booking, both parties, its status history, payments, payouts, cases and tickets.',
    params: id,
    response: adminBookingDetailSchema,
  });
  add({
    method: 'post',
    path: '/admin/bookings/{id}/status',
    summary: 'Staff: mark a trip as started or completed',
    description:
      'Only CONFIRMED → ACTIVE and ACTIVE → COMPLETED, with the same side effects as check-in and check-out (plan §8.2).',
    params: id,
    body: adminStatusEditSchema,
    response: adminBookingDetailSchema,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/bookings/{id}/refunds',
    summary: 'Staff with the refunds permission: refund the Guest',
    description:
      'A Host-funded refund comes off the trip’s payout, or once that’s sent, off the Host’s next payout or back from the Stripe transfer as staff choose (recoverFrom). The answer’s hostRefund says which (plan §8.1, item 15).',
    params: id,
    body: adminRefundSchema,
    response: adminBookingDetailSchema,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/vehicles/{id}/suspend',
    summary: 'Staff: suspend a car',
    description:
      'Hidden at once; its upcoming bookings are returned for staff to keep or cancel (plan §8.2).',
    params: id,
    body: suspendSchema,
    response: adminVehicleSuspensionSchema,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/vehicles/{id}/unsuspend',
    summary: 'Staff: lift a car’s suspension',
    params: id,
    response: adminVehicleSuspensionSchema,
    errors: [401, 403, 404, 409],
  });

  // Payments and payouts
  add({
    method: 'get',
    path: '/admin/payments',
    summary: 'Staff with the refunds permission: payments',
    query: paymentListQuerySchema,
    response: adminPaymentsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/payouts',
    summary: 'Staff with the refunds permission: Host payouts',
    query: payoutListQuerySchema,
    response: adminPayoutsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/refunds',
    summary: 'Staff with the refunds permission: every refund',
    description:
      'Refunds on every payment, newest first, by status, who funds them and why they were made, or by booking reference. A Host-funded refund says how it has been recovered from the Host (plan §8.1, item 15).',
    query: refundListQuerySchema,
    response: adminRefundsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/extra-charges',
    summary: 'Staff with the refunds permission: unpaid extra charges',
    description:
      'Extra charges on any booking still being collected (PENDING) or that failed, newest first, with the last failure and the tries on the saved card (plan §8.1, item 6).',
    query: extraChargeListQuerySchema,
    response: adminExtraChargesResponseSchema,
    errors: [400, 401, 403],
  });
  const payoutResponse = z.object({ payout: adminPayoutSchema }).meta({ id: 'AdminPayoutResponse' });
  add({
    method: 'post',
    path: '/admin/payouts/{id}/hold',
    summary: 'Admin: hold a payout',
    params: id,
    body: holdPayoutSchema,
    response: payoutResponse,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/payouts/{id}/release',
    summary: 'Admin: release a held payout',
    description: 'It is checked again now: a hold that still applies puts it back on hold.',
    params: id,
    response: payoutResponse,
    errors: [401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/payouts/{id}/retry',
    summary: 'Admin: send a failed payout again',
    params: id,
    response: payoutResponse,
    errors: [401, 403, 404, 409],
  });

  // Support inbox
  add({
    method: 'get',
    path: '/admin/support/tickets',
    summary: 'Staff: the support inbox',
    query: ticketListQuerySchema,
    response: staffTicketsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/support/tickets/{ref}',
    summary: 'Staff: a support ticket, with internal notes',
    params: ref,
    response: staffTicketResponseSchema,
  });
  add({
    method: 'post',
    path: '/admin/support/tickets/{ref}/messages',
    summary: 'Staff: reply to a ticket (emailed) or add an internal note',
    params: ref,
    body: staffTicketReplySchema,
    response: staffTicketResponseSchema,
    errors: [400, 401, 403, 404],
  });
  add({
    method: 'patch',
    path: '/admin/support/tickets/{ref}',
    summary: 'Staff: change a ticket’s status, or take it',
    params: ref,
    body: ticketUpdateSchema,
    response: staffTicketResponseSchema,
    errors: [400, 401, 403, 404],
  });

  // Moderation
  add({
    method: 'get',
    path: '/admin/moderation/reports',
    summary: 'Staff: what members reported',
    query: z.object({ status: z.enum(['OPEN', 'ACTIONED', 'DISMISSED']).optional() }),
    response: adminReportsResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'post',
    path: '/admin/moderation/reports/{id}/resolve',
    summary: 'Staff: action or dismiss a report, with what was done',
    params: id,
    body: resolveReportSchema,
    response: z.object({ report: adminReportSchema }).meta({ id: 'AdminReportResponse' }),
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'post',
    path: '/admin/moderation/messages/{id}/remove',
    summary: 'Staff: remove a member’s message',
    description:
      'Only a reported message (409 NOT_REPORTED otherwise). Both sides then see “This message was removed by Rento Vroom support.” in its place, without its photos, also in the recipient’s new-message notice; staff still see it in the conversation, marked removed. 409 ALREADY_REMOVED, or SYSTEM_MESSAGE for Rento Vroom’s own messages.',
    params: id,
    body: removeMessageSchema,
    response: removedMessageResponseSchema,
    errors: [400, 401, 403, 404, 409],
  });

  // Content
  add({
    method: 'get',
    path: '/admin/content/featured-vehicles',
    summary: 'Admin: the homepage’s featured cars',
    response: adminFeaturedResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/featured-vehicles',
    summary: 'Admin: choose the homepage’s featured cars',
    description: 'Up to eight, in order. None: the best-rated live cars are shown.',
    body: featuredVehiclesSchema,
    response: adminFeaturedResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/vehicles',
    summary: 'Admin: live cars to feature, by make, model or town',
    query: z.object({ q: z.string().optional() }),
    response: vehicleChoicesResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/hero',
    summary: 'Admin: the homepage’s headline and supporting line',
    description: 'The original text until an admin saves their own (`saved: false`).',
    response: adminHomeHeroSchema,
    errors: [401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/hero',
    summary: 'Admin: change the homepage’s headline and supporting line',
    body: homeHeroSchema,
    response: adminHomeHeroSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/featured-reviews',
    summary: 'Admin: the customer reviews picked for the homepage',
    description:
      'In order, each saying whether it can show now, with the threshold in settings and how many reviews are published: the section stays hidden until there are enough.',
    response: adminFeaturedReviewsSchema,
    errors: [401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/featured-reviews',
    summary: 'Admin: pick the homepage’s customer reviews',
    description:
      'Up to six published Guest reviews with words to quote, in order. None: the newest well-rated reviews are shown. One hidden later is left off the homepage.',
    body: featuredReviewsSchema,
    response: adminFeaturedReviewsSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/reviews',
    summary: 'Admin: published Guest reviews to pick for the homepage, by their words',
    query: z.object({ q: z.string().optional() }),
    response: reviewChoicesResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/footer',
    summary: 'Admin: the footer’s links and social accounts',
    description: 'The original links until an admin saves their own (`saved: false`).',
    response: adminSiteFooterSchema,
    errors: [401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/footer',
    summary: 'Admin: change the footer’s links and social accounts',
    description:
      'Links are full https:// addresses or paths on the website, like /help; social accounts are https:// addresses.',
    body: siteFooterSchema,
    response: adminSiteFooterSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/content/legal',
    summary: 'Admin: the legal pages',
    response: legalPagesResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/legal/{key}',
    summary: 'Admin: correct a legal page’s wording',
    description:
      'The version stays the same; a new version members accept again is published with a release.',
    params: z.object({ key: z.string() }),
    body: legalPageEditSchema,
    response: z.object({ page: legalPageSchema }).meta({ id: 'AdminLegalPageResponse' }),
    errors: [400, 401, 403, 404],
  });
  const destinationResponse = z
    .object({ destination: adminDestinationSchema })
    .meta({ id: 'AdminDestinationResponse' });
  add({
    method: 'get',
    path: '/admin/content/destinations',
    summary: 'Admin: destination landing pages, published or not',
    response: adminDestinationsResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'post',
    path: '/admin/content/destinations',
    summary: 'Admin: add a destination landing page',
    description:
      'At /rental/{slug}, which can’t change later. Airports must be in the place list. 409 SLUG_TAKEN when another page has the address.',
    body: destinationCreateSchema,
    response: destinationResponse,
    created: true,
    errors: [400, 401, 403, 409],
  });
  add({
    method: 'patch',
    path: '/admin/content/destinations/{slug}',
    summary: 'Admin: edit a destination landing page, or publish or unpublish it',
    description:
      'Only the fields sent change; empty text removes an optional one. Unpublished, it’s off the homepage, its page answers 404 and the sitemap leaves it out.',
    params: z.object({ slug: z.string() }),
    body: destinationEditSchema,
    response: destinationResponse,
    errors: [400, 401, 403, 404],
  });
  const faqResponse = z.object({ faq: adminFaqSchema }).meta({ id: 'AdminFaqResponse' });
  add({
    method: 'get',
    path: '/admin/content/faqs',
    summary: 'Admin: FAQs',
    response: adminFaqsResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'post',
    path: '/admin/content/faqs',
    summary: 'Admin: add a FAQ',
    body: faqInputSchema,
    response: faqResponse,
    created: true,
    errors: [400, 401, 403],
  });
  add({
    method: 'put',
    path: '/admin/content/faqs/{id}',
    summary: 'Admin: edit a FAQ',
    params: id,
    body: faqInputSchema,
    response: faqResponse,
    errors: [400, 401, 403, 404],
  });
  add({ method: 'delete', path: '/admin/content/faqs/{id}', summary: 'Admin: delete a FAQ', params: id });
  const articleResponse = z
    .object({ article: adminHelpArticleSchema })
    .meta({ id: 'AdminHelpArticleResponse' });
  add({
    method: 'get',
    path: '/admin/content/help-articles',
    summary: 'Admin: help articles, published or not',
    response: adminHelpArticlesResponseSchema,
    errors: [401, 403],
  });
  add({
    method: 'post',
    path: '/admin/content/help-articles',
    summary: 'Admin: add a help article',
    body: helpArticleInputSchema,
    response: articleResponse,
    created: true,
    errors: [400, 401, 403, 409],
  });
  add({
    method: 'put',
    path: '/admin/content/help-articles/{id}',
    summary: 'Admin: edit a help article',
    params: id,
    body: helpArticleInputSchema,
    response: articleResponse,
    errors: [400, 401, 403, 404, 409],
  });
  add({
    method: 'delete',
    path: '/admin/content/help-articles/{id}',
    summary: 'Admin: delete a help article',
    params: id,
  });

  // Reports, audit log and jobs
  add({
    method: 'get',
    path: '/admin/reports/summary',
    summary: 'Admin: platform figures for a range of NZ days',
    query: reportRangeSchema,
    response: z.object({ report: platformReportSchema }).meta({ id: 'PlatformReportResponse' }),
    errors: [400, 401, 403],
  });
  registry.registerPath({
    method: 'get',
    path: '/admin/reports/export',
    tags: ['Admin'],
    summary: 'Admin: a report as a CSV file',
    description:
      'Bookings, payments, refunds, payouts, cancellations, the monthly GST summary, or revenue and fees by day, for a range of NZ days. Every total matches the summary for the same days.',
    security: signedIn,
    request: { query: exportQuerySchema },
    responses: {
      200: { description: 'The CSV file', content: { 'text/csv': { schema: z.string() } } },
      ...errorResponses(400, 401, 403),
    },
  });
  add({
    method: 'get',
    path: '/admin/audit',
    summary: 'Admin: the audit log',
    query: auditQuerySchema,
    response: auditResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'get',
    path: '/admin/jobs',
    summary: 'Admin: background jobs that failed, are waiting or are running',
    query: jobQuerySchema,
    response: adminJobsResponseSchema,
    errors: [400, 401, 403],
  });
  add({
    method: 'post',
    path: '/admin/jobs/{id}/retry',
    summary: 'Admin: run a failed job again',
    params: id,
    response: z
      .object({ job: z.object({ id: z.string(), status: z.string() }) })
      .meta({ id: 'AdminJobRetryResponse' }),
  });
}
