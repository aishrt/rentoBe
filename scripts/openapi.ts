/**
 * Writes the API contract to openapi.json (plan §2.3). Run after changing a route or its schemas,
 * and commit the file: the pipeline fails when it's out of date, and the website generates its
 * API types from it (`npm run api:types` in frontend/).
 */
import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument } from '../src/openapi/document.js';

await writeFile('openapi.json', `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log('Wrote openapi.json');
