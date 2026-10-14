import { resolve, sep } from 'node:path';
import { env } from '../../env.js';

/** The local driver's folder, as an absolute path. */
export const localUploadRoot = () => resolve(env.UPLOAD_DIR);

/** Where the local storage driver keeps a file. Keys are made by the API, never by the browser. */
export function localFilePath(key: string): string {
  const root = localUploadRoot();
  const path = resolve(root, key);
  if (!path.startsWith(root + sep)) throw new Error('A file key left the upload folder');
  return path;
}
