import type { NzRegion } from '../../src/lib/model-fields.js';

/*
 * NZ places for location autocomplete and airport search (plan §3 `places`). Coordinates are approximate
 * centres, good enough for suggestions and radius search; Google Places fills in street addresses.
 */

export interface SeedPlace {
  name: string;
  lat: number;
  lng: number;
}

export interface SeedAirport extends SeedPlace {
  code: string;
}

export interface SeedCity extends SeedPlace {
  region: NzRegion;
  popularity: number;
  suburbs?: SeedPlace[];
  airport?: SeedAirport;
}

export const CITIES: SeedCity[] = [
  {
    name: 'Auckland',
    region: 'Auckland',
    lat: -36.8485,
    lng: 174.7633,
    popularity: 100,
    airport: { code: 'AKL', name: 'Auckland Airport', lat: -37.0082, lng: 174.785 },
    suburbs: [
      { name: 'Auckland Central', lat: -36.8466, lng: 174.765 },
      { name: 'Ponsonby', lat: -36.856, lng: 174.744 },
      { name: 'Parnell', lat: -36.855, lng: 174.781 },
      { name: 'Newmarket', lat: -36.87, lng: 174.777 },
      { name: 'Mount Eden', lat: -36.878, lng: 174.756 },
      { name: 'Devonport', lat: -36.83, lng: 174.796 },
      { name: 'Takapuna', lat: -36.788, lng: 174.772 },
      { name: 'Albany', lat: -36.729, lng: 174.697 },
      { name: 'Henderson', lat: -36.88, lng: 174.63 },
      { name: 'Manukau', lat: -36.993, lng: 174.88 },
    ],
  },
  {
    name: 'Queenstown',
    region: 'Otago',
    lat: -45.0312,
    lng: 168.6626,
    popularity: 95,
    airport: { code: 'ZQN', name: 'Queenstown Airport', lat: -45.0211, lng: 168.7392 },
    suburbs: [
      { name: 'Frankton', lat: -45.018, lng: 168.73 },
      { name: 'Arthurs Point', lat: -44.993, lng: 168.674 },
      { name: 'Fernhill', lat: -45.039, lng: 168.642 },
      { name: 'Kelvin Heights', lat: -45.052, lng: 168.696 },
    ],
  },
  {
    name: 'Christchurch',
    region: 'Canterbury',
    lat: -43.5321,
    lng: 172.6362,
    popularity: 90,
    airport: { code: 'CHC', name: 'Christchurch Airport', lat: -43.4894, lng: 172.5322 },
    suburbs: [
      { name: 'Christchurch Central', lat: -43.531, lng: 172.637 },
      { name: 'Riccarton', lat: -43.531, lng: 172.598 },
      { name: 'Addington', lat: -43.544, lng: 172.615 },
      { name: 'Merivale', lat: -43.513, lng: 172.619 },
      { name: 'Papanui', lat: -43.495, lng: 172.609 },
      { name: 'Hornby', lat: -43.543, lng: 172.526 },
      { name: 'Sumner', lat: -43.569, lng: 172.759 },
    ],
  },
  {
    name: 'Wellington',
    region: 'Wellington',
    lat: -41.2866,
    lng: 174.7756,
    popularity: 90,
    airport: { code: 'WLG', name: 'Wellington Airport', lat: -41.3272, lng: 174.8053 },
    suburbs: [
      { name: 'Te Aro', lat: -41.295, lng: 174.775 },
      { name: 'Thorndon', lat: -41.275, lng: 174.779 },
      { name: 'Kelburn', lat: -41.287, lng: 174.764 },
      { name: 'Karori', lat: -41.284, lng: 174.739 },
      { name: 'Miramar', lat: -41.315, lng: 174.815 },
      { name: 'Petone', lat: -41.227, lng: 174.871 },
    ],
  },
  {
    name: 'Rotorua',
    region: 'Bay of Plenty',
    lat: -38.1368,
    lng: 176.2497,
    popularity: 80,
    airport: { code: 'ROT', name: 'Rotorua Airport', lat: -38.1092, lng: 176.3172 },
    suburbs: [
      { name: 'Rotorua Central', lat: -38.138, lng: 176.251 },
      { name: 'Glenholme', lat: -38.147, lng: 176.246 },
      { name: 'Lynmore', lat: -38.151, lng: 176.28 },
      { name: 'Ngongotahā', lat: -38.083, lng: 176.21 },
    ],
  },
  {
    name: 'Tauranga',
    region: 'Bay of Plenty',
    lat: -37.6878,
    lng: 176.1651,
    popularity: 65,
    airport: { code: 'TRG', name: 'Tauranga Airport', lat: -37.6719, lng: 176.1961 },
  },
  {
    name: 'Hamilton',
    region: 'Waikato',
    lat: -37.787,
    lng: 175.2793,
    popularity: 60,
    airport: { code: 'HLZ', name: 'Hamilton Airport', lat: -37.8667, lng: 175.332 },
  },
  {
    name: 'Dunedin',
    region: 'Otago',
    lat: -45.8788,
    lng: 170.5028,
    popularity: 60,
    airport: { code: 'DUD', name: 'Dunedin Airport', lat: -45.9281, lng: 170.1983 },
  },
  {
    name: 'Taupō',
    region: 'Waikato',
    lat: -38.6857,
    lng: 176.0702,
    popularity: 60,
    airport: { code: 'TUO', name: 'Taupō Airport', lat: -38.7397, lng: 176.0844 },
  },
  {
    name: 'Wānaka',
    region: 'Otago',
    lat: -44.7032,
    lng: 169.1321,
    popularity: 60,
    airport: { code: 'WKA', name: 'Wānaka Airport', lat: -44.7222, lng: 169.2456 },
  },
  {
    name: 'Nelson',
    region: 'Nelson',
    lat: -41.2706,
    lng: 173.284,
    popularity: 55,
    airport: { code: 'NSN', name: 'Nelson Airport', lat: -41.2983, lng: 173.2211 },
  },
  {
    name: 'Napier',
    region: "Hawke's Bay",
    lat: -39.4928,
    lng: 176.912,
    popularity: 50,
    airport: { code: 'NPE', name: "Hawke's Bay Airport", lat: -39.4658, lng: 176.87 },
  },
  { name: 'Paihia', region: 'Northland', lat: -35.282, lng: 174.091, popularity: 45 },
  {
    name: 'Whangārei',
    region: 'Northland',
    lat: -35.7251,
    lng: 174.3237,
    popularity: 40,
    airport: { code: 'WRE', name: 'Whangārei Airport', lat: -35.7683, lng: 174.365 },
  },
  {
    name: 'New Plymouth',
    region: 'Taranaki',
    lat: -39.0556,
    lng: 174.0752,
    popularity: 40,
    airport: { code: 'NPL', name: 'New Plymouth Airport', lat: -39.0086, lng: 174.1792 },
  },
  {
    name: 'Palmerston North',
    region: 'Manawatū-Whanganui',
    lat: -40.3523,
    lng: 175.6082,
    popularity: 40,
    airport: { code: 'PMR', name: 'Palmerston North Airport', lat: -40.3206, lng: 175.6169 },
  },
  {
    name: 'Blenheim',
    region: 'Marlborough',
    lat: -41.5134,
    lng: 173.9612,
    popularity: 40,
    airport: { code: 'BHE', name: 'Marlborough Airport', lat: -41.5183, lng: 173.8703 },
  },
  { name: 'Te Anau', region: 'Southland', lat: -45.4145, lng: 167.718, popularity: 40 },
  { name: 'Hastings', region: "Hawke's Bay", lat: -39.6381, lng: 176.8492, popularity: 35 },
  {
    name: 'Invercargill',
    region: 'Southland',
    lat: -46.4132,
    lng: 168.3538,
    popularity: 35,
    airport: { code: 'IVC', name: 'Invercargill Airport', lat: -46.4124, lng: 168.313 },
  },
  { name: 'Kaikōura', region: 'Canterbury', lat: -42.4008, lng: 173.6814, popularity: 35 },
  {
    name: 'Gisborne',
    region: 'Gisborne',
    lat: -38.6623,
    lng: 178.0176,
    popularity: 30,
    airport: { code: 'GIS', name: 'Gisborne Airport', lat: -38.6633, lng: 177.9783 },
  },
  { name: 'Timaru', region: 'Canterbury', lat: -44.397, lng: 171.255, popularity: 25 },
  { name: 'Greymouth', region: 'West Coast', lat: -42.4504, lng: 171.2108, popularity: 25 },
];

/** Places visitors search for that aren't towns. */
export const VISITOR_DESTINATIONS: (SeedPlace & { region: NzRegion; popularity: number })[] = [
  { name: 'Milford Sound', region: 'Southland', lat: -44.6414, lng: 167.8974, popularity: 70 },
  { name: 'Hobbiton Movie Set', region: 'Waikato', lat: -37.8721, lng: 175.6829, popularity: 65 },
  { name: 'Aoraki / Mount Cook', region: 'Canterbury', lat: -43.734, lng: 170.096, popularity: 60 },
  { name: 'Lake Tekapo', region: 'Canterbury', lat: -44.0046, lng: 170.4771, popularity: 60 },
  { name: 'Bay of Islands', region: 'Northland', lat: -35.225, lng: 174.12, popularity: 55 },
  { name: 'Waitomo Caves', region: 'Waikato', lat: -38.261, lng: 175.1036, popularity: 50 },
  { name: 'Tongariro National Park', region: 'Manawatū-Whanganui', lat: -39.2, lng: 175.54, popularity: 50 },
  { name: 'Franz Josef Glacier', region: 'West Coast', lat: -43.389, lng: 170.183, popularity: 50 },
  { name: 'Abel Tasman National Park', region: 'Tasman', lat: -41.0, lng: 173.007, popularity: 45 },
  { name: 'Coromandel', region: 'Waikato', lat: -36.758, lng: 175.499, popularity: 45 },
];
