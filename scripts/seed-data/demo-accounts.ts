import type { Role } from '../../src/modules/users/user.model.js';

export type DemoCity = 'Auckland' | 'Wellington' | 'Christchurch' | 'Queenstown' | 'Rotorua';

export interface DemoLicence {
  number: string;
  version?: string;
  class: 'NZ_FULL' | 'OVERSEAS';
  country: string;
}

export interface DemoAccount {
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  /** Hosts: the city their demo cars are in. */
  hostCity?: DemoCity;
  /** A Host applicant waiting for approval, with a listing under review, for the staff queues. */
  applicant?: boolean;
  bio?: string;
  /** A verified mobile, so the account can book or host straight away (plan §6.1). */
  phone?: string;
  /** Guests: licence details for checkout's verification step, and a date of birth. */
  licence?: DemoLicence;
}

/** Demo accounts for local development and staging, all with the SEED_DEMO_PASSWORD password. */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'admin@rentovroom.test', firstName: 'Aroha', lastName: 'Admin', roles: ['ADMIN'] },
  { email: 'support@rentovroom.test', firstName: 'Sam', lastName: 'Support', roles: ['SUPPORT'] },
  {
    email: 'host@rentovroom.test',
    phone: '+6421000101',
    firstName: 'Hana',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Auckland',
    bio: 'Auckland local with a few cars to share. Happy to deliver to the airport.',
  },
  {
    email: 'host.wellington@rentovroom.test',
    phone: '+6421000102',
    firstName: 'Tama',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Wellington',
    bio: 'Wellington born and raised. Ask me for the best coffee on the way out of town.',
  },
  {
    email: 'host.christchurch@rentovroom.test',
    phone: '+6421000103',
    firstName: 'Mere',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Christchurch',
    bio: 'Family cars and utes for Canterbury road trips.',
  },
  {
    email: 'host.queenstown@rentovroom.test',
    phone: '+6421000104',
    firstName: 'Liam',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Queenstown',
    bio: 'Alpine-ready cars with ski racks and snow chains in winter.',
  },
  {
    email: 'host.rotorua@rentovroom.test',
    phone: '+6421000105',
    firstName: 'Ana',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Rotorua',
    bio: 'Hybrids and EVs for exploring the lakes and geothermal parks.',
  },
  {
    email: 'host.applicant@rentovroom.test',
    firstName: 'Rawiri',
    lastName: 'Applicant',
    roles: ['GUEST', 'HOST'],
    applicant: true,
    phone: '+6421000106',
    bio: 'New to hosting: one family SUV to share around Auckland.',
  },
  {
    email: 'guest@rentovroom.test',
    firstName: 'Kiri',
    lastName: 'Guest',
    roles: ['GUEST'],
    phone: '+6421000201',
    licence: { number: 'DK123456', version: '101', class: 'NZ_FULL', country: 'New Zealand' },
  },
  {
    email: 'visitor@rentovroom.test',
    firstName: 'Emma',
    lastName: 'Visitor',
    roles: ['GUEST'],
    phone: '+61412000202',
    licence: { number: '12345678', class: 'OVERSEAS', country: 'Australia' },
  },
  {
    email: 'guest2@rentovroom.test',
    firstName: 'Nikau',
    lastName: 'Guest',
    roles: ['GUEST'],
    phone: '+6421000203',
    licence: { number: 'NK654321', version: '203', class: 'NZ_FULL', country: 'New Zealand' },
  },
];
