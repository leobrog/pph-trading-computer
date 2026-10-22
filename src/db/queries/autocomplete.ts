import { sql } from "../index.ts";
import type { LandingPadSize } from "../../listener/normalizer.ts";

export interface SystemAutocompleteRow {
  id: number;
  name: string;
  population: number | null;
  is_under_colonisation: boolean;
}

export interface StationAutocompleteRow {
  market_id: string;
  name: string;
  system_name: string;
  max_landing_pad: LandingPadSize;
  is_fleet_carrier: boolean;
  is_colonisation_vessel: boolean;
  distance_to_arrival_ls: number | null;
}

export interface CommodityAutocompleteRow {
  id: number;
  symbol: string;
  name: string;
  category: string;
  is_rare: boolean;
}

export interface FactionAutocompleteRow {
  id: number;
  name: string;
  allegiance: string | null;
  government: string | null;
  influence?: number | null;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

/**
 * Trigram-indexed autocomplete search for star systems.
 */
export async function searchSystems(
  query: string,
  limit = 25,
): Promise<SystemAutocompleteRow[]> {
  const q = query.trim();
  const safeLimit = Math.min(25, Math.max(1, limit));

  if (!q) {
    return await sql<SystemAutocompleteRow[]>`
      SELECT
        id::int AS id,
        name,
        population::bigint AS population,
        is_under_colonisation
      FROM systems
      ORDER BY
        CASE WHEN LOWER(name) = 'heverty' THEN 0 ELSE 1 END,
        COALESCE(population, 0) DESC,
        updated_at DESC
      LIMIT ${safeLimit}
    `;
  }

  const escaped = escapeLike(q);
  const substringPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;

  return await sql<SystemAutocompleteRow[]>`
    SELECT
      id::int AS id,
      name,
      population::bigint AS population,
      is_under_colonisation
    FROM systems
    WHERE name ILIKE ${substringPattern}
    ORDER BY
      CASE
        WHEN LOWER(name) = LOWER(${q}) THEN 0
        WHEN LOWER(name) LIKE LOWER(${prefixPattern}) THEN 1
        ELSE 2
      END,
      COALESCE(population, 0) DESC,
      LENGTH(name) ASC,
      name ASC
    LIMIT ${safeLimit}
  `;
}

/**
 * Context-aware trigram-indexed autocomplete search for stations.
 * If `systemName` is supplied, restricts station results to that star system.
 */
export async function searchStations(
  query: string,
  systemName?: string | null,
  limit = 25,
): Promise<StationAutocompleteRow[]> {
  const q = query.trim();
  const sysFilter = systemName?.trim() || null;
  const safeLimit = Math.min(25, Math.max(1, limit));

  const escaped = escapeLike(q);
  const substringPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;

  if (sysFilter) {
    if (!q) {
      return await sql<StationAutocompleteRow[]>`
        SELECT
          st.market_id::text AS market_id,
          st.name,
          sys.name AS system_name,
          st.max_landing_pad,
          st.is_fleet_carrier,
          st.is_colonisation_vessel,
          st.distance_to_arrival_ls
        FROM stations st
        JOIN systems sys ON sys.id = st.system_id
        WHERE LOWER(sys.name) = LOWER(${sysFilter})
        ORDER BY
          st.is_fleet_carrier ASC,
          COALESCE(st.distance_to_arrival_ls, 999999) ASC,
          st.name ASC
        LIMIT ${safeLimit}
      `;
    }

    return await sql<StationAutocompleteRow[]>`
      SELECT
        st.market_id::text AS market_id,
        st.name,
        sys.name AS system_name,
        st.max_landing_pad,
        st.is_fleet_carrier,
        st.is_colonisation_vessel,
        st.distance_to_arrival_ls
      FROM stations st
      JOIN systems sys ON sys.id = st.system_id
      WHERE LOWER(sys.name) = LOWER(${sysFilter})
        AND st.name ILIKE ${substringPattern}
      ORDER BY
        CASE
          WHEN LOWER(st.name) = LOWER(${q}) THEN 0
          WHEN LOWER(st.name) LIKE LOWER(${prefixPattern}) THEN 1
          ELSE 2
        END,
        st.is_fleet_carrier ASC,
        st.name ASC
      LIMIT ${safeLimit}
    `;
  }

  if (!q) {
    return await sql<StationAutocompleteRow[]>`
      SELECT
        st.market_id::text AS market_id,
        st.name,
        sys.name AS system_name,
        st.max_landing_pad,
        st.is_fleet_carrier,
        st.is_colonisation_vessel,
        st.distance_to_arrival_ls
      FROM stations st
      JOIN systems sys ON sys.id = st.system_id
      WHERE st.is_fleet_carrier = false
      ORDER BY st.updated_at DESC
      LIMIT ${safeLimit}
    `;
  }

  return await sql<StationAutocompleteRow[]>`
    SELECT
      st.market_id::text AS market_id,
      st.name,
      sys.name AS system_name,
      st.max_landing_pad,
      st.is_fleet_carrier,
      st.is_colonisation_vessel,
      st.distance_to_arrival_ls
    FROM stations st
    JOIN systems sys ON sys.id = st.system_id
    WHERE st.name ILIKE ${substringPattern}
    ORDER BY
      CASE
        WHEN LOWER(st.name) = LOWER(${q}) THEN 0
        WHEN LOWER(st.name) LIKE LOWER(${prefixPattern}) THEN 1
        ELSE 2
      END,
      st.is_fleet_carrier ASC,
      st.updated_at DESC,
      st.name ASC
    LIMIT ${safeLimit}
  `;
}

/**
 * Trigram-indexed autocomplete search for commodities by display name, symbol, or category.
 */
export async function searchCommodities(
  query: string,
  limit = 25,
): Promise<CommodityAutocompleteRow[]> {
  const q = query.trim();
  const safeLimit = Math.min(25, Math.max(1, limit));

  if (!q) {
    return await sql<CommodityAutocompleteRow[]>`
      SELECT id, symbol, name, category, is_rare
      FROM commodities
      WHERE is_rare = false
      ORDER BY name ASC
      LIMIT ${safeLimit}
    `;
  }

  const escaped = escapeLike(q);
  const substringPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;

  return await sql<CommodityAutocompleteRow[]>`
    SELECT id, symbol, name, category, is_rare
    FROM commodities
    WHERE name ILIKE ${substringPattern}
       OR symbol ILIKE ${substringPattern}
       OR category ILIKE ${substringPattern}
    ORDER BY
      CASE
        WHEN LOWER(name) = LOWER(${q}) OR LOWER(symbol) = LOWER(${q}) THEN 0
        WHEN LOWER(name) LIKE LOWER(${prefixPattern}) THEN 1
        ELSE 2
      END,
      is_rare ASC,
      name ASC
    LIMIT ${safeLimit}
  `;
}

/**
 * Context-aware trigram-indexed autocomplete search for Minor Factions.
 * If `systemName` is supplied, prioritizes factions present in that star system.
 */
export async function searchFactions(
  query: string,
  systemName?: string | null,
  limit = 25,
): Promise<FactionAutocompleteRow[]> {
  const q = query.trim();
  const sysFilter = systemName?.trim() || null;
  const safeLimit = Math.min(25, Math.max(1, limit));

  const escaped = escapeLike(q);
  const substringPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;

  if (sysFilter) {
    const sysRows = await sql<FactionAutocompleteRow[]>`
      SELECT
        f.id,
        f.name,
        f.allegiance,
        f.government,
        sf.influence
      FROM system_factions sf
      JOIN systems sys ON sys.id = sf.system_id
      JOIN factions f ON f.id = sf.faction_id
      WHERE LOWER(sys.name) = LOWER(${sysFilter})
        AND (${q === ""} OR f.name ILIKE ${substringPattern})
      ORDER BY
        sf.influence DESC NULLS LAST,
        f.name ASC
      LIMIT ${safeLimit}
    `;

    if (sysRows.length > 0) {
      return sysRows;
    }
  }

  if (!q) {
    return await sql<FactionAutocompleteRow[]>`
      SELECT id, name, allegiance, government
      FROM factions
      ORDER BY
        CASE WHEN LOWER(name) = 'people''s party of heverty' THEN 0 ELSE 1 END,
        updated_at DESC,
        name ASC
      LIMIT ${safeLimit}
    `;
  }

  return await sql<FactionAutocompleteRow[]>`
    SELECT id, name, allegiance, government
    FROM factions
    WHERE name ILIKE ${substringPattern}
    ORDER BY
      CASE
        WHEN LOWER(name) = LOWER(${q}) THEN 0
        WHEN LOWER(name) LIKE LOWER(${prefixPattern}) THEN 1
        ELSE 2
      END,
      updated_at DESC,
      name ASC
    LIMIT ${safeLimit}
  `;
}
