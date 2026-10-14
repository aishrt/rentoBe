/*
 * CSV downloads (the staff reports, the Host's earnings statement). Each file starts with a byte order mark
 * (CSV_BOM), so Excel on Windows reads it as UTF-8 and shows macrons (Ōtautahi, Māori names) as they are.
 */

export const CSV_BOM = '﻿';

/** A text cell, quoted when needed, and never read as a spreadsheet formula. */
export const csvText = (value: string | undefined) => {
  const safe = /^[=+\-@\t\r]/.test(value ?? '') ? `'${value}` : (value ?? '');
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
