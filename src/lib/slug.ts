/** "2022 Toyota RAV4 Hybrid, Ōtāhuhu" → "2022-toyota-rav4-hybrid-otahuhu". */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
