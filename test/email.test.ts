import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { renderEmail, sendEmail } from '../src/emails/index.js';
import { parseEnv } from '../src/env.js';
import { createMailer } from '../src/integrations/mailer/index.js';
import { createConsoleMailer } from '../src/integrations/mailer/console-mailer.js';
import { MailerError } from '../src/integrations/mailer/mailer.types.js';
import { createResendMailer } from '../src/integrations/mailer/resend-mailer.js';

const silentLogger = pino({ level: 'silent' });
const welcomeProps = { firstName: 'Hana', browseUrl: 'https://www.example.co.nz/' };

describe('email templates', () => {
  it('renders the welcome email as HTML and plain text', async () => {
    const email = await renderEmail('welcome', welcomeProps);

    expect(email.subject).toBe('Welcome to Rento Vroom, Hana');
    expect(email.html).toContain('Kia ora, <!-- -->Hana');
    expect(email.html).toContain('href="https://www.example.co.nz/"');
    // The plain-text version writes headings in capitals and puts links after their label.
    expect(email.text).toContain('KIA ORA, HANA');
    expect(email.text).toContain('Explore Rento Vroom https://www.example.co.nz/');
    expect(email.text).not.toContain('<');
  });
});

describe('console mailer', () => {
  it('saves the email to disk instead of sending it', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'rv-mail-'));
    try {
      const mailer = createConsoleMailer({ logger: silentLogger, outputDir });
      const result = await sendEmail(
        { to: 'hana@example.co.nz', template: 'welcome', props: welcomeProps },
        mailer,
      );

      expect(result.provider).toBe('console');
      const [file] = await readdir(outputDir);
      expect(file).toBe(`${result.id}.html`);
      expect(await readFile(join(outputDir, file!), 'utf8')).toContain('Rento Vroom');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('Resend mailer', () => {
  it('sends through Resend with the configured sender', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 're_123' }, error: null });
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'Rento Vroom <hello@mail.example.com>',
      replyTo: 'support@example.com',
      client: { emails: { send } } as never,
    });

    const result = await mailer.send({
      to: 'hana@example.co.nz',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({ id: 're_123', provider: 'resend' });
    expect(send).toHaveBeenCalledWith({
      from: 'Rento Vroom <hello@mail.example.com>',
      to: 'hana@example.co.nz',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      replyTo: 'support@example.com',
    });
  });

  it('throws when Resend refuses the email', async () => {
    const send = vi.fn().mockResolvedValue({ data: null, error: { message: 'Domain not verified' } });
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'x@example.com',
      client: { emails: { send } } as never,
    });

    await expect(mailer.send({ to: 'a@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      MailerError,
    );
  });
});

describe('mail configuration', () => {
  const baseEnv = {
    MONGODB_URI: 'mongodb://localhost/test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('uses the console mailer by default', () => {
    const env = parseEnv(baseEnv);
    expect(env.MAIL_DRIVER).toBe('console');
    expect(createMailer(env, silentLogger).provider).toBe('console');
  });

  it('requires an API key when MAIL_DRIVER=resend', () => {
    expect(() => parseEnv({ ...baseEnv, MAIL_DRIVER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(
      createMailer(parseEnv({ ...baseEnv, MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_x' })).provider,
    ).toBe('resend');
  });

  it('treats empty values from .env as unset', () => {
    const env = parseEnv({ ...baseEnv, RESEND_API_KEY: '', EMAIL_REPLY_TO: '', COOKIE_DOMAIN: '' });
    expect(env.EMAIL_REPLY_TO).toBeUndefined();
    expect(env.COOKIE_DOMAIN).toBeUndefined();
  });
});
