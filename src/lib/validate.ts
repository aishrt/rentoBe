import type { z } from 'zod';
import { HttpError } from './http-error.js';

/** Parses request input with a Zod schema, or throws a 400 with one message per invalid field. */
export function validate<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', fields);
}
