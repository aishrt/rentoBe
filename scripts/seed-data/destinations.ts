import type { Destination } from '../../src/modules/cms/destination.model.js';
import { point } from '../../src/lib/model-fields.js';

// Published by default; admins unpublish a page from the staff portal.
type SeedDestination = Omit<Destination, 'createdAt' | 'updatedAt' | 'published'>;

/**
 * The five launch destinations (MILESTONES.md, Phase 4), in the homepage order. Taglines match the
 * homepage tiles in the frontend. Admins edit these and add more.
 */
export const DESTINATIONS: SeedDestination[] = [
  {
    slug: 'queenstown',
    city: 'Queenstown',
    maoriName: 'Tāhuna',
    region: 'Otago',
    tagline: 'Alpine roads, lakes and the ski fields, all within an hour or two.',
    intro:
      'Queenstown sits on the shore of Lake Wakatipu, beneath the Remarkables. Pick up a car from a local host and drive to Glenorchy and Arrowtown, over the Crown Range to Wānaka, or up to the ski fields at Coronet Peak and The Remarkables.',
    location: point(168.6626, -45.0312),
    airports: ['ZQN'],
    featured: true,
    order: 1,
  },
  {
    slug: 'auckland',
    city: 'Auckland',
    maoriName: 'Tāmaki Makaurau',
    region: 'Auckland',
    tagline: 'Harbour city, island ferries and wild west coast beaches.',
    intro:
      'New Zealand’s largest city spreads across two harbours and dozens of volcanic cones. Collect a car in the city or at the airport, then head for the west coast beaches at Piha and Muriwai, across to the Coromandel, or north to the Bay of Islands.',
    location: point(174.7633, -36.8485),
    airports: ['AKL'],
    featured: true,
    order: 2,
  },
  {
    slug: 'christchurch',
    city: 'Christchurch',
    maoriName: 'Ōtautahi',
    region: 'Canterbury',
    tagline: 'The gateway to Arthur’s Pass and the Southern Alps.',
    intro:
      'Christchurch is the South Island’s largest city and the starting point for Arthur’s Pass, Akaroa and Kaikōura, and for the drive south to Lake Tekapo and Aoraki / Mount Cook.',
    location: point(172.6362, -43.5321),
    airports: ['CHC'],
    featured: true,
    order: 3,
  },
  {
    slug: 'wellington',
    city: 'Wellington',
    maoriName: 'Te Whanganui-a-Tara',
    region: 'Wellington',
    tagline: 'The harbour capital, with the Wairarapa wine trail next door.',
    intro:
      'The capital wraps around its harbour, with Te Papa, the waterfront and plenty of cafés in walking distance. With a car you can cross the Remutaka Hill to the Wairarapa wine country, or follow the Kāpiti Coast north.',
    location: point(174.7756, -41.2866),
    airports: ['WLG'],
    featured: true,
    order: 4,
  },
  {
    slug: 'rotorua',
    city: 'Rotorua',
    region: 'Bay of Plenty',
    tagline: 'Geothermal valleys, lakes and redwood forest trails.',
    intro:
      'Rotorua is known for its geysers, mud pools and Māori culture. From town, Wai-O-Tapu, the Redwoods, Lake Tarawera and Taupō are all an easy drive.',
    location: point(176.2497, -38.1368),
    airports: ['ROT'],
    featured: true,
    order: 5,
  },
];
