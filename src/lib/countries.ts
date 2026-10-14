/*
 * Countries by ISO 3166-1 alpha-2 code: an overseas driver licence keeps the code of the country that issued
 * it, so it can be compared with a card's country (plan §14, risk flags). Licences saved before then hold the
 * country as typed, so names and common short forms are read as codes too.
 */

/** Every ISO 3166-1 alpha-2 code, with Kosovo's XK, used on its licences. */
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY ' +
  'BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK ' +
  'FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR ' +
  'IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ' +
  'ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
  'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF ' +
  'TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');

const codes = new Set(COUNTRY_CODES);
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** "Côte d’Ivoire" and "cote d'ivoire" alike: lower case, no accents, punctuation or leading "the". */
const normalise = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\b\.?/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');

/** Short forms and older names people type, beyond the names Intl knows. */
const ALIASES: Record<string, string> = {
  usa: 'US',
  'u s': 'US',
  'u s a': 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'u k': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  'united kingdom of great britain and northern ireland': 'GB',
  holland: 'NL',
  korea: 'KR',
  'republic of korea': 'KR',
  'czech republic': 'CZ',
  turkey: 'TR',
  'ivory coast': 'CI',
  macedonia: 'MK',
  swaziland: 'SZ',
  burma: 'MM',
  'hong kong': 'HK',
  macau: 'MO',
  macao: 'MO',
  uae: 'AE',
  emirates: 'AE',
  'russian federation': 'RU',
  vatican: 'VA',
  'cabo verde': 'CV',
  'east timor': 'TL',
  prc: 'CN',
  'peoples republic of china': 'CN',
  'people s republic of china': 'CN',
  deutschland: 'DE',
  aotearoa: 'NZ',
  'aotearoa new zealand': 'NZ',
  eire: 'IE',
  'republic of ireland': 'IE',
  palestine: 'PS',
  'viet nam': 'VN',
  'lao pdr': 'LA',
  persia: 'IR',
  drc: 'CD',
  'democratic republic of the congo': 'CD',
  'republic of the congo': 'CG',
};

let byName: Map<string, string> | undefined;
/** Each code's English name (and its name without the bracketed part, "Myanmar (Burma)"), normalised. */
function names(): Map<string, string> {
  if (byName) return byName;
  byName = new Map();
  for (const code of COUNTRY_CODES) {
    const name = regionNames.of(code);
    if (!name) continue;
    byName.set(normalise(name), code);
    const plain = name.replace(/\s*\(.*\)$/, '').replace(/ SAR China$/, '');
    byName.set(normalise(plain), code);
  }
  return byName;
}

/** The ISO code for a code, a country's name or a common short form ("USA", "UK", "England"); else undefined. */
export function countryCode(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const key = normalise(trimmed);
  if (ALIASES[key]) return ALIASES[key];
  if (/^[A-Za-z]{2}$/.test(trimmed) && codes.has(trimmed.toUpperCase())) return trimmed.toUpperCase();
  return names().get(key);
}

/** A country's English name from its code ("United States"), or the value as it was when it isn't one. */
export function countryName(value: string): string {
  const code = countryCode(value);
  return (code && regionNames.of(code)) || value;
}
