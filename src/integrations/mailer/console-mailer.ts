import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Mailer } from './mailer.types.js';

interface ConsoleMailerOptions {
  logger: Logger;
  /** Where each email's HTML is saved so it can be opened in a browser. */
  outputDir?: string;
}

const extractLinks = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

/** Local development mailer: logs the subject and links, and saves the HTML to backend/.mail/ (plan §7). */
export function createConsoleMailer({ logger, outputDir = '.mail' }: ConsoleMailerOptions): Mailer {
  return {
    provider: 'console',
    async send(message) {
      const id = `console-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
      await mkdir(outputDir, { recursive: true });
      const file = join(outputDir, `${id}.html`);
      await writeFile(file, message.html, 'utf8');

      logger.info(
        { to: message.to, subject: message.subject, links: extractLinks(message.html), file },
        'Email captured by the console mailer (not sent)',
      );
      return { id, provider: 'console' };
    },
  };
}
