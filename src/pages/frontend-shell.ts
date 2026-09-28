import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../integrations/logger.js';
import { SEO_BLOCK } from './page-tags.js';

/*
 * The website's current app shell (index.html) and its SEO manifest, fetched from the live website and
 * kept for 60 s, so page tags always wrap the latest frontend release (plan §1.4, item 2).
 */

const manifestSchema = z.object({
  /** Static public pages search engines may index, e.g. "/". */
  indexablePaths: z.array(z.string().startsWith('/')),
  /** Whether the website has built its vehicle pages (/cars/:slug) yet. */
  vehiclePages: z.boolean(),
  /** Whether the website has built its city and destination pages (/rental/:city) yet. */
  destinationPages: z.boolean(),
});
export type SeoManifest = z.infer<typeof manifestSchema>;

/** Until the website says otherwise, nothing is indexable. */
const NOTHING_BUILT: SeoManifest = { indexablePaths: [], vehiclePages: false, destinationPages: false };

const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

let shell: { html: string; expiresAt: number } | undefined;
let manifest: { value: SeoManifest; expiresAt: number } | undefined;

async function fetchFromWebsite(path: string): Promise<string> {
  const response = await fetch(new URL(path, env.FRONTEND_URL), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} on the website answered ${response.status}`);
  return response.text();
}

/** index.html with its <!-- seo:start --> block. Throws when the website can't be reached. */
export async function getAppShell(): Promise<string> {
  if (shell && shell.expiresAt > Date.now()) return shell.html;
  const html = await fetchFromWebsite('/index.html');
  if (!SEO_BLOCK.test(html)) throw new Error('The website’s index.html has no <!-- seo:start --> block');
  shell = { html, expiresAt: Date.now() + CACHE_MS };
  return html;
}

/** What the website has built. If it can't be read, nothing is treated as indexable. */
export async function getSeoManifest(): Promise<SeoManifest> {
  if (manifest && manifest.expiresAt > Date.now()) return manifest.value;
  let value = NOTHING_BUILT;
  try {
    value = manifestSchema.parse(JSON.parse(await fetchFromWebsite('/seo-manifest.json')));
  } catch (error) {
    logger.warn(
      { err: error },
      'Could not read the website’s seo-manifest.json; treating nothing as indexable',
    );
  }
  manifest = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

/** Forgets the cached copies (tests). */
export function clearWebsiteCache(): void {
  shell = undefined;
  manifest = undefined;
}
