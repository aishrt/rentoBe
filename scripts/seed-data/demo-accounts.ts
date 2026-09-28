import type { Role } from '../../src/modules/users/user.model.js';

export type DemoCity = 'Auckland' | 'Wellington' | 'Christchurch' | 'Queenstown' | 'Rotorua';

export interface DemoAccount {
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  /** Hosts: the city their demo cars are in. */
  hostCity?: DemoCity;
  bio?: string;
}

/** Demo accounts for local development and staging, all with the SEED_DEMO_PASSWORD password. */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'admin@rentovroom.test', firstName: 'Aroha', lastName: 'Admin', roles: ['ADMIN'] },
  { email: 'support@rentovroom.test', firstName: 'Sam', lastName: 'Support', roles: ['SUPPORT'] },
  {
    email: 'host@rentovroom.test',
    firstName: 'Hana',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Auckland',
    bio: 'Auckland local with a few cars to share. Happy to deliver to the airport.',
  },
  {
    email: 'host.wellington@rentovroom.test',
    firstName: 'Tama',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Wellington',
    bio: 'Wellington born and raised. Ask me for the best coffee on the way out of town.',
  },
  {
    email: 'host.christchurch@rentovroom.test',
    firstName: 'Mere',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Christchurch',
    bio: 'Family cars and utes for Canterbury road trips.',
  },
  {
    email: 'host.queenstown@rentovroom.test',
    firstName: 'Liam',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Queenstown',
    bio: 'Alpine-ready cars with ski racks and snow chains in winter.',
  },
  {
    email: 'host.rotorua@rentovroom.test',
    firstName: 'Ana',
    lastName: 'Host',
    roles: ['GUEST', 'HOST'],
    hostCity: 'Rotorua',
    bio: 'Hybrids and EVs for exploring the lakes and geothermal parks.',
  },
  { email: 'guest@rentovroom.test', firstName: 'Kiri', lastName: 'Guest', roles: ['GUEST'] },
  { email: 'visitor@rentovroom.test', firstName: 'Emma', lastName: 'Visitor', roles: ['GUEST'] },
  { email: 'guest2@rentovroom.test', firstName: 'Nikau', lastName: 'Guest', roles: ['GUEST'] },
];
