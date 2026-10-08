import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { env } from '../../env.js';
import { maskPhone } from '../../lib/phone.js';
import { logger } from '../logger.js';

/**
 * Text messages other than verification codes (plan §7): new booking requests for Hosts, pickup and
 * return reminders, and unread messages for those who opt in. Twilio's Messages API in production, from
 * a Messaging Service or a Twilio number; the console driver logs them locally, and the dummy driver logs
 * them on a deployed API until Twilio has a sender.
 */
export interface SmsSender {
  readonly provider: 'twilio' | 'console' | 'dummy';
  /** Sends one message and returns the provider's message id. */
  send(to: string, body: string): Promise<string>;
}

export class SmsNotConfiguredError extends Error {
  override name = 'SmsNotConfiguredError';
}

export function createTwilioSender(config: {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
  from?: string;
  fetch?: typeof fetch;
}): SmsSender {
  const { fetch: fetchImpl = globalThis.fetch } = config;
  const authorization = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;

  return {
    provider: 'twilio',
    async send(to, body) {
      const sender: Record<string, string> | null = config.messagingServiceSid
        ? { MessagingServiceSid: config.messagingServiceSid }
        : config.from
          ? { From: config.from }
          : null;
      if (!sender)
        throw new SmsNotConfiguredError('Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER to send SMS');
      const response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, Body: body, ...sender }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        sid?: string;
        code?: number;
        message?: string;
      };
      if (!response.ok || !result.sid) {
        throw new Error(
          `Twilio refused the SMS: ${result.code ?? response.status} ${result.message ?? ''}`.trim(),
        );
      }
      return result.sid;
    },
  };
}

const sentByConsole: { to: string; body: string }[] = [];

export function createConsoleSender(log: Logger = logger): SmsSender {
  return {
    provider: 'console',
    async send(to, body) {
      sentByConsole.push({ to, body });
      log.info({ to, body }, 'SMS (console driver: not sent)');
      return `console-${sentByConsole.length}`;
    },
  };
}

/** Tests: the messages the console driver "sent". */
export function consoleSmsOutbox(): { to: string; body: string }[] {
  return sentByConsole;
}

/**
 * Stand-in for Twilio on a deployed API (SMS_DRIVER=dummy): logs the message with the number half
 * hidden, and the notification is recorded as sent with a `dummy-` reference instead of Twilio's id.
 */
export function createDummySender(log: Logger = logger): SmsSender {
  return {
    provider: 'dummy',
    async send(to, body) {
      const id = `dummy-${randomUUID()}`;
      log.info({ to: maskPhone(to), body, id }, 'SMS not sent (dummy driver)');
      return id;
    },
  };
}

let sender: SmsSender | undefined;

export function getSmsSender(): SmsSender {
  sender ??=
    env.SMS_DRIVER === 'twilio'
      ? createTwilioSender({
          accountSid: env.TWILIO_ACCOUNT_SID!,
          authToken: env.TWILIO_AUTH_TOKEN!,
          messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
          from: env.TWILIO_FROM_NUMBER,
        })
      : env.SMS_DRIVER === 'dummy'
        ? createDummySender()
        : createConsoleSender();
  return sender;
}
