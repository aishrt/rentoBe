import { JobModel } from './jobs/job.model.js';
import { RateLimitModel } from './middleware/rate-limit-store.js';
import { PlatformSettingsModel } from './modules/admin/platform-settings.model.js';
import { AuditLogModel } from './modules/audit/audit-log.model.js';
import { AuthTokenModel } from './modules/auth/auth-token.model.js';
import { SessionModel } from './modules/auth/session.model.js';
import { AvailabilityBlockModel } from './modules/availability/availability-block.model.js';
import { BookingModel } from './modules/bookings/booking.model.js';
import { CmsBlockModel } from './modules/cms/cms-block.model.js';
import { DestinationModel } from './modules/cms/destination.model.js';
import { ExchangeRateModel } from './modules/currency/exchange-rate.model.js';
import { FaqModel } from './modules/help/faq.model.js';
import { HelpArticleModel } from './modules/help/help-article.model.js';
import { IncidentModel } from './modules/incidents/incident.model.js';
import { ConditionReportModel } from './modules/inspections/condition-report.model.js';
import { MessageModel } from './modules/messages/message.model.js';
import { ThreadModel } from './modules/messages/thread.model.js';
import { ReportModel } from './modules/moderation/report.model.js';
import { NotificationModel } from './modules/notifications/notification.model.js';
import { PaymentModel } from './modules/payments/payment.model.js';
import { StripeEventModel } from './modules/payments/stripe-event.model.js';
import { PayoutModel } from './modules/payouts/payout.model.js';
import { ReviewModel } from './modules/reviews/review.model.js';
import { PlaceModel } from './modules/search/place.model.js';
import { SupportTicketModel } from './modules/support/support-ticket.model.js';
import { UserModel } from './modules/users/user.model.js';
import { VehicleModel } from './modules/vehicles/vehicle.model.js';

/**
 * Every Mongoose model, one per collection (plan §3), for scripts that work on all of them, such as the
 * index sync. The API imports each model where it's used; add a new model here as well.
 */
export const allModels = [
  UserModel,
  SessionModel,
  AuthTokenModel,
  VehicleModel,
  AvailabilityBlockModel,
  BookingModel,
  PaymentModel,
  PayoutModel,
  ThreadModel,
  MessageModel,
  ReviewModel,
  ConditionReportModel,
  IncidentModel,
  ReportModel,
  SupportTicketModel,
  HelpArticleModel,
  NotificationModel,
  JobModel,
  AuditLogModel,
  StripeEventModel,
  FaqModel,
  CmsBlockModel,
  PlaceModel,
  DestinationModel,
  PlatformSettingsModel,
  RateLimitModel,
  ExchangeRateModel,
] as const;
