/**
 * Previews every email template in the browser with sample details (plan §7):
 *
 *   npm run email:dev      then open http://localhost:3030
 *
 * It restarts when a template changes (tsx watch); reload the page to see the change. Nothing is sent.
 */
import { createServer } from 'node:http';
import { emailTemplates, renderEmail, type EmailTemplateName } from '../src/emails/index.js';
import { previewProps } from '../src/emails/preview-props.js';

const PORT = 3030;
const names = Object.keys(emailTemplates) as EmailTemplateName[];

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function indexPage(): Promise<string> {
  const rows = await Promise.all(
    names.map(async (name) => {
      const { subject } = await renderEmail(name, previewProps[name]);
      return `<li><a href="/${name}">${name}</a> · ${escapeHtml(subject)} · <a href="/${name}.txt">text</a></li>`;
    }),
  );
  return `<!doctype html><meta charset="utf-8"><title>Rento Vroom emails</title>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.8">
<h1>Rento Vroom emails</h1><p>Each template with sample details. Nothing is sent.</p><ul>${rows.join('')}</ul>`;
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
  const asText = path.endsWith('.txt');
  const name = (asText ? path.slice(0, -'.txt'.length) : path) as EmailTemplateName;

  const respond = async () => {
    if (path === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await indexPage());
    } else if (names.includes(name)) {
      const email = await renderEmail(name, previewProps[name]);
      res
        .writeHead(200, { 'Content-Type': `text/${asText ? 'plain' : 'html'}; charset=utf-8` })
        .end(asText ? email.text : email.html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No such email');
    }
  };
  respond().catch((error: unknown) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(error));
  });
}).listen(PORT, () => console.log(`Email previews on http://localhost:${PORT}`));
