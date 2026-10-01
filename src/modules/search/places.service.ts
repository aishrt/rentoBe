import mongoose from 'mongoose';
import { getPlacesProvider } from '../../integrations/places/places-provider.js';
import { logger } from '../../integrations/logger.js';
import type { NzRegion } from '../../lib/model-fields.js';
import { PlaceModel, toSearchName, type PlaceType } from './place.model.js';
import type { PlaceDetails, PlaceSuggestion } from './search.schemas.js';

/*
 * Location autocomplete (plan §1.2, spec §21): our own NZ cities, suburbs, airports and visitor
 * destinations first, then street addresses from Google Places when it's set up.
 */

const MAX_OURS = 8;
const MAX_ADDRESSES = 5;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface PlaceRow {
  _id: mongoose.Types.ObjectId;
  type: PlaceType;
  name: string;
  region: string;
  code?: string;
  location: { coordinates: [number, number] };
  parentId?: mongoose.Types.ObjectId;
}

/** "Auckland Airport (AKL)" for airports, the plain name for everything else. */
export function placeLabel(place: Pick<PlaceRow, 'type' | 'name' | 'code'>): string {
  return place.type === 'AIRPORT' && place.code ? `${place.name} (${place.code})` : place.name;
}

async function toSuggestions(places: PlaceRow[]): Promise<PlaceSuggestion[]> {
  const parentIds = places.flatMap((place) => (place.parentId ? [place.parentId] : []));
  const parents = parentIds.length
    ? await PlaceModel.find({ _id: mongoose.trusted({ $in: parentIds }) })
        .select('name')
        .lean()
    : [];
  const parentName = (id?: mongoose.Types.ObjectId) =>
    parents.find((parent) => id && parent._id.equals(id))?.name;

  return places.map((place) => {
    const [lng, lat] = place.location.coordinates;
    const secondary =
      place.type === 'SUBURB'
        ? [parentName(place.parentId), place.region].filter(Boolean).join(', ')
        : place.region;
    return {
      id: `place:${place._id.toString()}`,
      type: place.type,
      name: place.name,
      label: placeLabel(place),
      secondary: secondary === place.name ? undefined : secondary,
      ...(place.code && { code: place.code }),
      city: place.type === 'CITY' ? place.name : (parentName(place.parentId) ?? place.name),
      region: place.region as NzRegion,
      lat,
      lng,
    };
  });
}

/** Our places for what's typed so far: names that start with it, then names with a word that does. */
export async function suggestOurPlaces(query: string): Promise<PlaceSuggestion[]> {
  const typed = toSearchName(query).replace(/\s+/g, ' ');
  const fields = 'type name region code location parentId';
  if (!typed) {
    const popular = await PlaceModel.find({
      type: mongoose.trusted({ $in: ['CITY', 'AIRPORT', 'DESTINATION'] }),
    })
      .sort({ popularity: -1, name: 1 })
      .limit(MAX_OURS)
      .select(fields)
      .lean<PlaceRow[]>();
    return toSuggestions(popular);
  }

  const code = /^[a-z]{3}$/.test(typed) ? typed.toUpperCase() : undefined;
  const [starts, airports] = await Promise.all([
    // An anchored prefix match uses the searchName index (plan §3).
    PlaceModel.find({ searchName: mongoose.trusted({ $regex: `^${escapeRegex(typed)}` }) })
      .sort({ popularity: -1, name: 1 })
      .limit(MAX_OURS)
      .select(fields)
      .lean<PlaceRow[]>(),
    code ? PlaceModel.find({ type: 'AIRPORT', code }).select(fields).lean<PlaceRow[]>() : [],
  ]);

  const found = [
    ...airports,
    ...starts.filter((place) => !airports.some((airport) => airport._id.equals(place._id))),
  ];
  if (found.length < MAX_OURS) {
    // "central" finds Auckland Central. The places list is small, so this scan is cheap.
    const words = await PlaceModel.find({
      searchName: mongoose.trusted({ $regex: `\\s${escapeRegex(typed)}` }),
      _id: mongoose.trusted({ $nin: found.map((place) => place._id) }),
    })
      .sort({ popularity: -1, name: 1 })
      .limit(MAX_OURS - found.length)
      .select(fields)
      .lean<PlaceRow[]>();
    found.push(...words);
  }
  return toSuggestions(found.slice(0, MAX_OURS));
}

/** Suggestions for the "Where are you going?" field. Google failing never breaks our own suggestions. */
export async function suggestPlaces(query: string, sessionToken?: string): Promise<PlaceSuggestion[]> {
  const ours = await suggestOurPlaces(query);
  const provider = getPlacesProvider();
  if (provider.provider === 'local' || query.trim().length < 3) return ours;

  try {
    const addresses = await provider.suggest(query.trim(), sessionToken);
    return [
      ...ours,
      ...addresses.slice(0, MAX_ADDRESSES).map((address) => ({
        id: `google:${address.placeId}`,
        type: 'ADDRESS' as const,
        name: address.main,
        label: [address.main, address.secondary].filter(Boolean).join(', '),
        secondary: address.secondary,
      })),
    ];
  } catch (error) {
    logger.warn({ err: error }, 'Google Places suggestions failed; showing our places only');
    return ours;
  }
}

/** Coordinates (and, for a street address, the NZ address) of a chosen suggestion. */
export async function placeDetails(id: string, sessionToken?: string): Promise<PlaceDetails | null> {
  const [kind, rawId] = id.split(/:(.*)/s) as [string, string | undefined];
  if (kind === 'place' && rawId && mongoose.isValidObjectId(rawId)) {
    const place = await PlaceModel.findById(rawId).lean<PlaceRow>();
    if (!place) return null;
    const [suggestion] = await toSuggestions([place]);
    return { ...suggestion!, lat: suggestion!.lat!, lng: suggestion!.lng! };
  }
  if (kind === 'google' && rawId) {
    const details = await getPlacesProvider().details(rawId, sessionToken);
    if (!details) return null;
    return {
      id,
      type: 'ADDRESS',
      name: details.address
        ? [details.address.streetNumber, details.address.street].filter(Boolean).join(' ')
        : details.label,
      label: details.label,
      lat: details.lat,
      lng: details.lng,
      ...(details.address && { address: details.address }),
    };
  }
  return null;
}

export interface ResolvedPlace {
  label: string;
  type: PlaceType | 'ADDRESS' | 'POINT';
  lat: number;
  lng: number;
  /** For airports: its IATA code, so cars that deliver there are found too. */
  airportCode?: string;
}

/**
 * The place a search is about: one of ours by id, a point the website already resolved, or typed
 * text matched to our best place. Null means all of NZ (plan §3: a search with no place).
 */
export async function resolveSearchPlace(input: {
  placeId?: string;
  lat?: number;
  lng?: number;
  where?: string;
  airport?: string;
}): Promise<ResolvedPlace | null> {
  if (input.placeId) {
    const details = await placeDetails(input.placeId);
    if (details) {
      return {
        label: details.label,
        type: details.type,
        lat: details.lat,
        lng: details.lng,
        ...(details.type === 'AIRPORT' && details.code && { airportCode: details.code }),
      };
    }
  }
  if (input.lat !== undefined && input.lng !== undefined) {
    return {
      label: input.where?.trim() || 'Selected location',
      type: input.airport ? 'AIRPORT' : 'POINT',
      lat: input.lat,
      lng: input.lng,
      ...(input.airport && { airportCode: input.airport.toUpperCase() }),
    };
  }
  if (input.airport) {
    const airport = await PlaceModel.findOne({
      type: 'AIRPORT',
      code: input.airport.toUpperCase(),
    }).lean<PlaceRow>();
    if (airport) return fromRow(airport);
  }
  const where = input.where?.replace(/\(([A-Z]{3})\)/i, ' $1 ').trim();
  if (!where) return null;

  // "Auckland Airport (AKL)", "AKL", "Taupo" or "Queenstown": exact name, airport code, then the best prefix.
  const typed = toSearchName(where.replace(/\s+[A-Z]{3}$/i, '')).replace(/\s+/g, ' ');
  const codeMatch = /\b([A-Za-z]{3})$/.exec(where)?.[1];
  const exact = await PlaceModel.findOne({ searchName: typed }).sort({ popularity: -1 }).lean<PlaceRow>();
  if (exact) return fromRow(exact);
  if (codeMatch) {
    const airport = await PlaceModel.findOne({
      type: 'AIRPORT',
      code: codeMatch.toUpperCase(),
    }).lean<PlaceRow>();
    if (airport) return fromRow(airport);
  }
  const [best] = await suggestOurPlaces(typed);
  if (!best) return null;
  return {
    label: best.label,
    type: best.type,
    lat: best.lat!,
    lng: best.lng!,
    ...(best.type === 'AIRPORT' && best.code && { airportCode: best.code }),
  };
}

function fromRow(place: PlaceRow): ResolvedPlace {
  const [lng, lat] = place.location.coordinates;
  return {
    label: placeLabel(place),
    type: place.type,
    lat,
    lng,
    ...(place.type === 'AIRPORT' && place.code && { airportCode: place.code }),
  };
}
