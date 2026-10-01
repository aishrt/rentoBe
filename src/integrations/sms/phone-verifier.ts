import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import { env, type Env } from '../../env.js';
import { maskPhone } from '../../lib/phone.js';
import { logger } from '../logger.js';

export type PhoneVerifierErrorCode =
  'INVALID_NUMBER' | 'TOO_MANY_CODES' | 'NUMBER_NOT_ALLOWED' | 'UNAVAILABLE';

export class PhoneVerifierError extends Error {
  override name = 'PhoneVerifierError';
  constructor(
    readonly code: PhoneVerifierErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Texts a one-time code to a mobile number and checks it (plan §6.1). Twilio Verify in production. */
export interface PhoneVerifier {
  readonly provider: 'twilio' | 'console' | 'dummy';
  sendCode(phone: string): Promise<void>;
  /** Whether the code is right and still valid for this number. */
  checkCode(phone: string, code: string): Promise<boolean>;
}

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  serviceSid: string;
  fetch?: typeof fetch;
}

/**
 * Twilio Verify over its REST API. Twilio generates, texts, expires (10 minutes) and rate-limits the
 * codes itself, so none are stored here.
 */
export function createTwilioVerifier({
  accountSid,
  authToken,
  serviceSid,
  fetch = globalThis.fetch,
}: TwilioConfig): PhoneVerifier {
  const base = `https://verify.twilio.com/v2/Services/${serviceSid}`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  const post = (path: string, body: Record<string, string>) =>
    fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

  return {
    provider: 'twilio',

    async sendCode(phone) {
      const response = await post('Verifications', { To: phone, Channel: 'sms', Locale: 'en' });
      if (response.ok) return;
      const error = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
      // https://www.twilio.com/docs/api/errors
      if (error.code === 60200 || error.code === 21211) {
        throw new PhoneVerifierError('INVALID_NUMBER', "That number can't receive texts.");
      }
      if (response.status === 429 || error.code === 60203) {
        throw new PhoneVerifierError(
          'TOO_MANY_CODES',
          "We've sent several codes to this number. Please try again in 10 minutes.",
        );
      }
      // 21608: a trial account can only text numbers verified in the Twilio console. 60410: blocked prefix.
      if (error.code === 21608 || error.code === 60410) {
        throw new PhoneVerifierError('NUMBER_NOT_ALLOWED', "We can't send texts to this number yet.");
      }
      throw new PhoneVerifierError(
        'UNAVAILABLE',
        `Twilio refused the code: ${error.code ?? response.status} ${error.message ?? ''}`,
      );
    },

    async checkCode(phone, code) {
      const response = await post('VerificationCheck', { To: phone, Code: code });
      // 404: no code waiting for this number (expired, used, or too many wrong tries).
      if (response.status === 404) return false;
      if (!response.ok)
        throw new PhoneVerifierError('UNAVAILABLE', `Twilio could not check the code (${response.status})`);
      const result = (await response.json()) as { status?: string };
      return result.status === 'approved';
    },
  };
}

const CONSOLE_CODE_TTL_MS = 10 * 60 * 1000;
const consoleCodes = new Map<string, { code: string; expiresAt: number }>();

/** Development and tests: logs the code instead of texting it. Codes live in this process only. */
export function createConsoleVerifier(log: Logger = logger): PhoneVerifier {
  return {
    provider: 'console',
    async sendCode(phone) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      consoleCodes.set(phone, { code, expiresAt: Date.now() + CONSOLE_CODE_TTL_MS });
      log.info({ phone, code }, 'SMS code (console driver: not sent)');
    },
    async checkCode(phone, code) {
      const sent = consoleCodes.get(phone);
      if (!sent || sent.expiresAt < Date.now() || sent.code !== code) return false;
      consoleCodes.delete(phone);
      return true;
    },
  };
}

/** Tests: the code the console driver "sent" to a number. */
export function consoleCodeFor(phone: string): string | undefined {
  return consoleCodes.get(phone)?.code;
}

/**
 * Stand-in for Twilio Verify on a deployed API while the Twilio account is a trial (SMS_DRIVER=dummy):
 * nothing is texted, and the one stand-in code verifies any number. It keeps no state, so it works on
 * every backend task. Numbers verified this way were never texted (the audit log records the driver).
 */
export function createDummyVerifier(stubCode: string, log: Logger = logger): PhoneVerifier {
  const expected = Buffer.from(stubCode);
  return {
    provider: 'dummy',
    async sendCode(phone) {
      log.info(
        { phone: maskPhone(phone) },
        'SMS code not sent (dummy driver: the stand-in code verifies it)',
      );
    },
    async checkCode(_phone, code) {
      const typed = Buffer.from(code);
      return typed.length === expected.length && timingSafeEqual(typed, expected);
    },
  };
}

type VerifierConfig = Pick<
  Env,
  'SMS_DRIVER' | 'SMS_DUMMY_CODE' | 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_VERIFY_SERVICE_SID'
>;

export function createPhoneVerifier(config: VerifierConfig): PhoneVerifier {
  if (config.SMS_DRIVER === 'twilio') {
    return createTwilioVerifier({
      accountSid: config.TWILIO_ACCOUNT_SID!,
      authToken: config.TWILIO_AUTH_TOKEN!,
      serviceSid: config.TWILIO_VERIFY_SERVICE_SID!,
    });
  }
  if (config.SMS_DRIVER === 'dummy') return createDummyVerifier(config.SMS_DUMMY_CODE!);
  return createConsoleVerifier();
}

let verifier: PhoneVerifier | undefined;

export function getPhoneVerifier(): PhoneVerifier {
  verifier ??= createPhoneVerifier(env);
  return verifier;
}
