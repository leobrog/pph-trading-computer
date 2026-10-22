import { normalizeCommoditySymbol } from "../../../scripts/seed-commodities.ts";
import { sql } from "../index.ts";
import type { LandingPadSize } from "../../listener/normalizer.ts";

/**
 * In-memory cache mapping lowercase EDDN commodity symbol -> commodities.id
 */
const commodityCache = new Map<string, number>();
let cacheInitialized = false;

/**
 * Loads all commodity symbols and IDs from PostgreSQL into memory.
 */
export async function initCommodityCache(): Promise<number> {
  const rows = await sql<{ id: number; symbol: string }[]>`
    SELECT id, symbol FROM commodities
  `;
  commodityCache.clear();
  for (const row of rows) {
    commodityCache.set(row.symbol.toLowerCase(), Number(row.id));
  }
  cacheInitialized = true;
  return commodityCache.size;
}

function formatFallbackCommodityName(symbol: string): string {
  return symbol
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Resolves a commodity symbol to its `commodities.id`, dynamically inserting
 * unknown commodities if Frontier introduces new items before FDevIDs updates.
 */
export async function resolveCommodityId(rawSymbol: string): Promise<number> {
  if (!cacheInitialized) {
    await initCommodityCache();
  }

  const symbol = normalizeCommoditySymbol(rawSymbol);
  const cached = commodityCache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }

  const fallbackName = formatFallbackCommodityName(symbol);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO commodities (symbol, name, category, is_rare)
    VALUES (${symbol}, ${fallbackName}, ${"Uncategorized"}, ${false})
    ON CONFLICT (symbol) DO UPDATE SET
      symbol = EXCLUDED.symbol
    RETURNING id
  `;

  const id = Number(rows[0]!.id);
  commodityCache.set(symbol, id);
  return id;
}

export interface UpsertSystemInput {
  name: string;
  systemAddress?: number | bigint | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  population?: number | bigint | null;
  isUnderColonisation?: boolean;
  allegiance?: string | null;
  government?: string | null;
  primaryEconomy?: string | null;
  security?: string | null;
  controllingFaction?: string | null;
  controllingPower?: string | null;
  powerplayState?: string | null;
  updatedAt: string;
}

export interface SystemRecord {
  id: number;
  name: string;
  x: number | null;
  y: number | null;
  z: number | null;
  population: number | null;
  is_under_colonisation: boolean;
}

/**
 * Upserts a populated or active-colonisation star system.
 * Uses a timestamp guard so older out-of-order journal events do not overwrite newer BGS states,
 * while always backfilling missing coordinates or system_address.
 */
export async function upsertSystem(input: UpsertSystemInput): Promise<SystemRecord> {
  const sysAddr = input.systemAddress != null ? String(input.systemAddress) : null;
  const pop = input.population != null ? String(input.population) : null;
  const isCol = input.isUnderColonisation ?? false;

  const rows = await sql<SystemRecord[]>`
    INSERT INTO systems (
      name, system_address, x, y, z, population, is_under_colonisation,
      allegiance, government, primary_economy, security,
      controlling_faction, controlling_power, powerplay_state, updated_at
    )
    VALUES (
      ${input.name},
      ${sysAddr},
      ${input.x ?? null},
      ${input.y ?? null},
      ${input.z ?? null},
      ${pop},
      ${isCol},
      ${input.allegiance ?? null},
      ${input.government ?? null},
      ${input.primaryEconomy ?? null},
      ${input.security ?? null},
      ${input.controllingFaction ?? null},
      ${input.controllingPower ?? null},
      ${input.powerplayState ?? null},
      ${input.updatedAt}
    )
    ON CONFLICT (name) DO UPDATE SET
      system_address = COALESCE(EXCLUDED.system_address, systems.system_address),
      x = COALESCE(EXCLUDED.x, systems.x),
      y = COALESCE(EXCLUDED.y, systems.y),
      z = COALESCE(EXCLUDED.z, systems.z),
      population = CASE
        WHEN EXCLUDED.population IS NOT NULL AND EXCLUDED.population > 1 THEN EXCLUDED.population
        WHEN COALESCE(systems.population, 0) > 1 THEN systems.population
        WHEN EXCLUDED.population IS NOT NULL AND EXCLUDED.population > 0 THEN EXCLUDED.population
        ELSE COALESCE(systems.population, EXCLUDED.population)
      END,
      is_under_colonisation = systems.is_under_colonisation OR EXCLUDED.is_under_colonisation,
      allegiance = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.allegiance, systems.allegiance)
        ELSE COALESCE(systems.allegiance, EXCLUDED.allegiance)
      END,
      government = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.government, systems.government)
        ELSE COALESCE(systems.government, EXCLUDED.government)
      END,
      primary_economy = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.primary_economy, systems.primary_economy)
        ELSE COALESCE(systems.primary_economy, EXCLUDED.primary_economy)
      END,
      security = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.security, systems.security)
        ELSE COALESCE(systems.security, EXCLUDED.security)
      END,
      controlling_faction = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.controlling_faction, systems.controlling_faction)
        ELSE COALESCE(systems.controlling_faction, EXCLUDED.controlling_faction)
      END,
      controlling_power = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.controlling_power, systems.controlling_power)
        ELSE COALESCE(systems.controlling_power, EXCLUDED.controlling_power)
      END,
      powerplay_state = CASE
        WHEN EXCLUDED.updated_at >= systems.updated_at THEN COALESCE(EXCLUDED.powerplay_state, systems.powerplay_state)
        ELSE COALESCE(systems.powerplay_state, EXCLUDED.powerplay_state)
      END,
      updated_at = GREATEST(systems.updated_at, EXCLUDED.updated_at)
    RETURNING
      id::int AS id,
      name,
      x,
      y,
      z,
      population::bigint AS population,
      is_under_colonisation
  `;

  return rows[0]!;
}

/**
 * Updates coordinates on an ALREADY-tracked system (e.g. an uninhabited system currently
 * marked `is_under_colonisation = true`), without ever inserting uninhabited systems.
 */
export async function updateTrackedSystemCoords(input: {
  name: string;
  systemAddress?: number | bigint | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
}): Promise<SystemRecord | null> {
  const sysAddr = input.systemAddress != null ? String(input.systemAddress) : null;
  const rows = await sql<SystemRecord[]>`
    UPDATE systems
    SET
      system_address = COALESCE(${sysAddr}, system_address),
      x = COALESCE(${input.x ?? null}, x),
      y = COALESCE(${input.y ?? null}, y),
      z = COALESCE(${input.z ?? null}, z)
    WHERE name = ${input.name}
      AND (is_under_colonisation = true OR COALESCE(population, 0) > 0)
    RETURNING
      id::int AS id,
      name,
      x,
      y,
      z,
      population::bigint AS population,
      is_under_colonisation
  `;
  return rows[0] ?? null;
}

/**
 * Looks up a system by exact name.
 */
export async function getSystemByName(name: string): Promise<SystemRecord | null> {
  const rows = await sql<SystemRecord[]>`
    SELECT
      id::int AS id,
      name,
      x,
      y,
      z,
      population::bigint AS population,
      is_under_colonisation
    FROM systems
    WHERE name = ${name}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface FactionStateEntry {
  State: string;
  Trend?: number;
}

export interface RawJournalFaction {
  Name: string;
  FactionState?: string;
  Government?: string;
  Influence?: number;
  Allegiance?: string;
  Happiness?: string;
  ActiveStates?: FactionStateEntry[];
  PendingStates?: FactionStateEntry[];
  RecoveringStates?: FactionStateEntry[];
}

export interface NormalizedFactionInput {
  name: string;
  allegiance: string | null;
  government: string | null;
  influence: number | null;
  factionState: string | null;
  happiness: string | null;
  activeStates: FactionStateEntry[];
  pendingStates: FactionStateEntry[];
  recoveringStates: FactionStateEntry[];
}

/**
 * Upserts minor factions and their per-system BGS influence/states for a populated system.
 */
export async function upsertSystemFactions(
  systemId: number,
  factions: NormalizedFactionInput[],
  updatedAt: string,
): Promise<void> {
  if (factions.length === 0) return;

  await sql.begin(async (tx) => {
    for (const f of factions) {
      if (!f.name || f.name.toLowerCase() === "pilots' federation local branch") {
        continue;
      }

      const factionRows = await tx<{ id: number }[]>`
        INSERT INTO factions (name, allegiance, government, updated_at)
        VALUES (${f.name}, ${f.allegiance}, ${f.government}, ${updatedAt})
        ON CONFLICT (name) DO UPDATE SET
          allegiance = COALESCE(EXCLUDED.allegiance, factions.allegiance),
          government = COALESCE(EXCLUDED.government, factions.government),
          updated_at = GREATEST(factions.updated_at, EXCLUDED.updated_at)
        RETURNING id
      `;

      const factionId = factionRows[0]!.id;
      const activeJson = JSON.stringify(f.activeStates);
      const pendingJson = JSON.stringify(f.pendingStates);
      const recoveringJson = JSON.stringify(f.recoveringStates);

      await tx`
        INSERT INTO system_factions (
          system_id, faction_id, influence, faction_state, happiness,
          active_states, pending_states, recovering_states, updated_at
        )
        VALUES (
          ${systemId},
          ${factionId},
          ${f.influence},
          ${f.factionState},
          ${f.happiness},
          ${activeJson}::jsonb,
          ${pendingJson}::jsonb,
          ${recoveringJson}::jsonb,
          ${updatedAt}
        )
        ON CONFLICT (system_id, faction_id) DO UPDATE SET
          influence = EXCLUDED.influence,
          faction_state = EXCLUDED.faction_state,
          happiness = COALESCE(EXCLUDED.happiness, system_factions.happiness),
          active_states = EXCLUDED.active_states,
          pending_states = EXCLUDED.pending_states,
          recovering_states = EXCLUDED.recovering_states,
          updated_at = EXCLUDED.updated_at
        WHERE EXCLUDED.updated_at >= system_factions.updated_at
      `;
    }
  });
}

export interface UpsertStationMetaInput {
  marketId: number | bigint;
  systemId: number;
  name: string;
  stationType?: string | null;
  isFleetCarrier: boolean;
  isColonisationVessel: boolean;
  maxLandingPad: LandingPadSize;
  padSmall?: number | null;
  padMedium?: number | null;
  padLarge?: number | null;
  distanceToArrivalLs?: number | null;
  controllingFaction?: string | null;
  controllingFactionState?: string | null;
  government?: string | null;
  primaryEconomy?: string | null;
  economies?: unknown | null;
  hasBlackmarket?: boolean | null;
  services?: string[] | null;
  carrierDockingAccess?: string | null;
  metaUpdatedAt: string;
}

/**
 * Upserts station metadata from `Docked`, `Location (Docked=true)`, or `CarrierJump` journal events.
 */
export async function upsertStationMeta(input: UpsertStationMetaInput): Promise<void> {
  const marketIdStr = String(input.marketId);
  const economiesJson = input.economies ? JSON.stringify(input.economies) : null;
  const servicesParam = input.services ? sql.array(input.services, "TEXT") : null;

  await sql`
    INSERT INTO stations (
      market_id, system_id, name, station_type,
      is_fleet_carrier, is_colonisation_vessel,
      max_landing_pad, pad_small, pad_medium, pad_large,
      distance_to_arrival_ls, controlling_faction, controlling_faction_state,
      government, primary_economy, economies,
      has_blackmarket, services, carrier_docking_access,
      meta_updated_at, updated_at
    )
    VALUES (
      ${marketIdStr},
      ${input.systemId},
      ${input.name},
      ${input.stationType ?? null},
      ${input.isFleetCarrier},
      ${input.isColonisationVessel},
      ${input.maxLandingPad},
      ${input.padSmall ?? null},
      ${input.padMedium ?? null},
      ${input.padLarge ?? null},
      ${input.distanceToArrivalLs ?? null},
      ${input.controllingFaction ?? null},
      ${input.controllingFactionState ?? null},
      ${input.government ?? null},
      ${input.primaryEconomy ?? null},
      ${economiesJson}::jsonb,
      ${input.hasBlackmarket ?? false},
      ${servicesParam},
      ${input.carrierDockingAccess ?? null},
      ${input.metaUpdatedAt},
      ${input.metaUpdatedAt}
    )
    ON CONFLICT (market_id) DO UPDATE SET
      system_id = CASE
        WHEN EXCLUDED.meta_updated_at >= COALESCE(stations.meta_updated_at, stations.updated_at)
        THEN EXCLUDED.system_id
        ELSE stations.system_id
      END,
      name = CASE
        WHEN EXCLUDED.meta_updated_at >= COALESCE(stations.meta_updated_at, stations.updated_at)
        THEN EXCLUDED.name
        ELSE stations.name
      END,
      station_type = COALESCE(EXCLUDED.station_type, stations.station_type),
      is_fleet_carrier = stations.is_fleet_carrier OR EXCLUDED.is_fleet_carrier,
      is_colonisation_vessel = stations.is_colonisation_vessel OR EXCLUDED.is_colonisation_vessel,
      max_landing_pad = COALESCE(EXCLUDED.max_landing_pad, stations.max_landing_pad),
      pad_small = COALESCE(EXCLUDED.pad_small, stations.pad_small),
      pad_medium = COALESCE(EXCLUDED.pad_medium, stations.pad_medium),
      pad_large = COALESCE(EXCLUDED.pad_large, stations.pad_large),
      distance_to_arrival_ls = COALESCE(EXCLUDED.distance_to_arrival_ls, stations.distance_to_arrival_ls),
      controlling_faction = CASE
        WHEN EXCLUDED.meta_updated_at >= COALESCE(stations.meta_updated_at, '1970-01-01T00:00:00Z'::timestamptz)
        THEN COALESCE(EXCLUDED.controlling_faction, stations.controlling_faction)
        ELSE COALESCE(stations.controlling_faction, EXCLUDED.controlling_faction)
      END,
      controlling_faction_state = CASE
        WHEN EXCLUDED.meta_updated_at >= COALESCE(stations.meta_updated_at, '1970-01-01T00:00:00Z'::timestamptz)
        THEN COALESCE(EXCLUDED.controlling_faction_state, stations.controlling_faction_state)
        ELSE COALESCE(stations.controlling_faction_state, EXCLUDED.controlling_faction_state)
      END,
      government = COALESCE(EXCLUDED.government, stations.government),
      primary_economy = COALESCE(EXCLUDED.primary_economy, stations.primary_economy),
      economies = COALESCE(EXCLUDED.economies, stations.economies),
      has_blackmarket = CASE
        WHEN EXCLUDED.services IS NOT NULL THEN EXCLUDED.has_blackmarket
        ELSE stations.has_blackmarket
      END,
      services = COALESCE(EXCLUDED.services, stations.services),
      carrier_docking_access = COALESCE(EXCLUDED.carrier_docking_access, stations.carrier_docking_access),
      meta_updated_at = GREATEST(COALESCE(stations.meta_updated_at, EXCLUDED.meta_updated_at), EXCLUDED.meta_updated_at),
      updated_at = GREATEST(stations.updated_at, EXCLUDED.updated_at)
  `;
}

export interface MarketCommodityItem {
  commodityId: number;
  meanPrice: number;
  buyPrice: number;
  stock: number;
  stockBracket: number | null;
  sellPrice: number;
  demand: number;
  demandBracket: number | null;
  statusFlags: string[] | null;
}

export interface UpsertStationMarketInput {
  marketId: number | bigint;
  systemId: number;
  stationName: string;
  stationType?: string | null;
  isFleetCarrier: boolean;
  isColonisationVessel: boolean;
  maxLandingPad: LandingPadSize;
  carrierDockingAccess?: string | null;
  economies?: unknown | null;
  prohibitedCommodities?: string[] | null;
  marketUpdatedAt: string;
  items: MarketCommodityItem[];
}

/**
 * Upserts a station's market snapshot (`commodity/3`) and replaces its `market_listings`
 * if and only if `marketUpdatedAt` is newer than or equal to the existing `market_updated_at`.
 */
export async function upsertStationMarket(
  input: UpsertStationMarketInput,
): Promise<{ updated: boolean; listingsCount: number }> {
  const marketIdStr = String(input.marketId);

  // Fast pre-check: skip if we already have a fresher market snapshot for this station
  const existing = await sql<{ market_updated_at: Date | string | null }[]>`
    SELECT market_updated_at
    FROM stations
    WHERE market_id = ${marketIdStr}
    LIMIT 1
  `;

  if (existing[0]?.market_updated_at) {
    const existingMs = new Date(existing[0].market_updated_at).getTime();
    const incomingMs = new Date(input.marketUpdatedAt).getTime();
    if (incomingMs < existingMs) {
      return { updated: false, listingsCount: 0 };
    }
  }

  const economiesJson = input.economies ? JSON.stringify(input.economies) : null;
  const prohibitedParam = input.prohibitedCommodities
    ? sql.array(input.prohibitedCommodities, "TEXT")
    : null;

  // Deduplicate items by commodityId within the snapshot
  const uniqueByCommodityId = new Map<number, MarketCommodityItem>();
  for (const item of input.items) {
    uniqueByCommodityId.set(item.commodityId, item);
  }
  const dedupedItems = Array.from(uniqueByCommodityId.values());

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO stations (
        market_id, system_id, name, station_type,
        is_fleet_carrier, is_colonisation_vessel,
        max_landing_pad, carrier_docking_access,
        economies, prohibited_commodities,
        market_updated_at, updated_at
      )
      VALUES (
        ${marketIdStr},
        ${input.systemId},
        ${input.stationName},
        ${input.stationType ?? null},
        ${input.isFleetCarrier},
        ${input.isColonisationVessel},
        ${input.maxLandingPad},
        ${input.carrierDockingAccess ?? null},
        ${economiesJson}::jsonb,
        ${prohibitedParam},
        ${input.marketUpdatedAt},
        ${input.marketUpdatedAt}
      )
      ON CONFLICT (market_id) DO UPDATE SET
        system_id = CASE
          WHEN EXCLUDED.market_updated_at >= COALESCE(stations.market_updated_at, '1970-01-01T00:00:00Z'::timestamptz)
          THEN EXCLUDED.system_id
          ELSE stations.system_id
        END,
        name = CASE
          WHEN EXCLUDED.market_updated_at >= COALESCE(stations.market_updated_at, '1970-01-01T00:00:00Z'::timestamptz)
          THEN EXCLUDED.name
          ELSE stations.name
        END,
        station_type = COALESCE(EXCLUDED.station_type, stations.station_type),
        is_fleet_carrier = stations.is_fleet_carrier OR EXCLUDED.is_fleet_carrier,
        is_colonisation_vessel = stations.is_colonisation_vessel OR EXCLUDED.is_colonisation_vessel,
        max_landing_pad = COALESCE(stations.max_landing_pad, EXCLUDED.max_landing_pad),
        carrier_docking_access = COALESCE(EXCLUDED.carrier_docking_access, stations.carrier_docking_access),
        economies = COALESCE(EXCLUDED.economies, stations.economies),
        prohibited_commodities = COALESCE(EXCLUDED.prohibited_commodities, stations.prohibited_commodities),
        market_updated_at = GREATEST(COALESCE(stations.market_updated_at, EXCLUDED.market_updated_at), EXCLUDED.market_updated_at),
        updated_at = GREATEST(stations.updated_at, EXCLUDED.updated_at)
    `;

    if (dedupedItems.length > 0) {
      const commodityIds = sql.array(
        dedupedItems.map((i) => i.commodityId),
        "INTEGER",
      );
      const meanPrices = sql.array(
        dedupedItems.map((i) => i.meanPrice),
        "INTEGER",
      );
      const buyPrices = sql.array(
        dedupedItems.map((i) => i.buyPrice),
        "INTEGER",
      );
      const stocks = sql.array(
        dedupedItems.map((i) => i.stock),
        "INTEGER",
      );
      const stockBrackets = sql.array(
        dedupedItems.map((i) => i.stockBracket),
        "SMALLINT",
      );
      const sellPrices = sql.array(
        dedupedItems.map((i) => i.sellPrice),
        "INTEGER",
      );
      const demands = sql.array(
        dedupedItems.map((i) => i.demand),
        "INTEGER",
      );
      const demandBrackets = sql.array(
        dedupedItems.map((i) => i.demandBracket),
        "SMALLINT",
      );

      await tx`
        INSERT INTO market_listings (
          market_id, commodity_id, mean_price, buy_price, stock, stock_bracket,
          sell_price, demand, demand_bracket, updated_at
        )
        SELECT
          ${marketIdStr}::bigint,
          u.commodity_id,
          u.mean_price,
          u.buy_price,
          u.stock,
          u.stock_bracket,
          u.sell_price,
          u.demand,
          u.demand_bracket,
          ${input.marketUpdatedAt}::timestamptz
        FROM UNNEST(
          ${commodityIds}::int[],
          ${meanPrices}::int[],
          ${buyPrices}::int[],
          ${stocks}::int[],
          ${stockBrackets}::smallint[],
          ${sellPrices}::int[],
          ${demands}::int[],
          ${demandBrackets}::smallint[]
        ) AS u(
          commodity_id,
          mean_price,
          buy_price,
          stock,
          stock_bracket,
          sell_price,
          demand,
          demand_bracket
        )
        ON CONFLICT (market_id, commodity_id) DO UPDATE SET
          mean_price = EXCLUDED.mean_price,
          buy_price = EXCLUDED.buy_price,
          stock = EXCLUDED.stock,
          stock_bracket = EXCLUDED.stock_bracket,
          sell_price = EXCLUDED.sell_price,
          demand = EXCLUDED.demand,
          demand_bracket = EXCLUDED.demand_bracket,
          updated_at = EXCLUDED.updated_at
        WHERE EXCLUDED.updated_at >= market_listings.updated_at
      `;
    }

    // Remove delisted commodities from previous snapshots for this station
    await tx`
      DELETE FROM market_listings
      WHERE market_id = ${marketIdStr}::bigint
        AND updated_at < ${input.marketUpdatedAt}::timestamptz
    `;
  });

  return { updated: true, listingsCount: dedupedItems.length };
}
