import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 10;

/*
 * Passwords of 10+ characters that appear near the top of breached-password lists. Shorter ones are
 * already refused by the length rule. Compared in lower case with spaces removed.
 */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '123456789a',
  '0123456789',
  '0987654321',
  '1111111111',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'a123456789',
  'aaaaaaaaaa',
  'abcd123456',
  'abcdefghij',
  'asdfghjkl1',
  'football123',
  'iloveyou123',
  'letmein123',
  'monkey1234',
  'password01',
  'password1!',
  'password12',
  'password123',
  'password1234',
  'password2024',
  'password2025',
  'password2026',
  'passw0rd123',
  'q1w2e3r4t5',
  'qazwsxedc123',
  'qwerty12345',
  'qwerty123456',
  'qwertyuiop',
  'qwertyuiop1',
  'sunshine123',
  'welcome123',
  'welcome1234',
  'zaq12wsxcde',
  'correcthorsebatterystaple',
  'rentovroom',
  'rentovroom1',
  'rentovroom123',
  'newzealand',
  'newzealand1',
  'newzealand123',
  'aotearoa123',
  'auckland123',
  'wellington1',
  'christchurch',
]);

/** A new password (plan §3): long enough, not a well-known one. */
export const newPasswordSchema = z
  .string({ error: 'Choose a password' })
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200, 'That password is too long')
  .refine((password) => !COMMON_PASSWORDS.has(password.toLowerCase().replaceAll(' ', '')), {
    error: 'That password is too common. Try a few unrelated words together.',
  });

/** Whether the password contains the name part of the email address, e.g. "kiri" in kiri@example.co.nz. */
export function passwordContainsEmailName(password: string, email: string): boolean {
  const name = email.split('@')[0]?.toLowerCase() ?? '';
  return name.length >= 4 && password.toLowerCase().includes(name);
}
