import { env } from "../../config/env.ts";
import { resolveSystemFromEdsm } from "../../listener/coord-resolver.ts";
import {
  cleanFdevToken,
  cleanStationName,
  inferMaxLandingPad,
  isColonisationVessel,
  isFleetCarrier,
  type LandingPadSize,
} from "../../listener/normalizer.ts";
import { sql } from "../index.ts";
import {
  initCommodityCache,
  type MarketCommodityItem,
  resolveCommodityId,
  upsertStationMarket,
  upsertStationMeta,
  upsertSystem,
} from "./ingest.ts";

export type PadFilter = "L" | "M" | "Any";

export interface ResolvedSystemInfo {
  id: number;
  name: string;
  x: number | null;
  y: number | null;
  z: number | null;
  population: number | null;
  controlling_faction: string | null;
}

export interface ResolvedCommodityInfo {
  id: number;
  symbol: string;
  name: string;
  category: string;
  is_rare: boolean;
}

/**
 * Finds a system by case-insensitive name in PostgreSQL, and if missing or lacking 3D coordinates,
 * attempts an on-demand lookup against EDSM so any populated system works immediately.
 */
export async function findOrResolveSystem(
  systemName: string,
): Promise<ResolvedSystemInfo | null> {
  const trimmed = systemName.trim();
  if (!trimmed) return null;

  const queryExisting = async (): Promise<ResolvedSystemInfo | null> => {
    const rows = await sql<ResolvedSystemInfo[]>`
      SELECT
        id::int AS id,
        name,
        x,
        y,
        z,
        population::bigint AS population,
        controlling_faction
      FROM systems
      WHERE LOWER(name) = LOWER(${trimmed})
      LIMIT 1
    `;
    return rows[0] ?? null;
  };

  let sys = await queryExisting();

  if (
    (!sys || sys.x === null) &&
    env.edsmResolverEnabled &&
    !trimmed.startsWith("PPH_TEST_")
  ) {
    try {
      await resolveSystemFromEdsm(sys?.name ?? trimmed);
      sys = await queryExisting();
    } catch {
      // Ignore Spansh/EDSM timeout or network failure and rely on local DB
    }
  }

  return sys;
}

/**
 * Resolves a commodity by exact name, symbol, or closest trigram substring match.
 */
export async function resolveCommodityByQuery(
  query: string,
): Promise<ResolvedCommodityInfo | null> {
  const q = query.trim();
  if (!q) return null;

  const exactRows = await sql<ResolvedCommodityInfo[]>`
    SELECT id, symbol, name, category, is_rare
    FROM commodities
    WHERE LOWER(name) = LOWER(${q})
       OR LOWER(symbol) = LOWER(${q})
    LIMIT 1
  `;
  if (exactRows[0]) return exactRows[0];

  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const prefix = `${q.replace(/[\\%_]/g, "\\$&")}%`;

  const fuzzyRows = await sql<ResolvedCommodityInfo[]>`
    SELECT id, symbol, name, category, is_rare
    FROM commodities
    WHERE name ILIKE ${pattern}
       OR symbol ILIKE ${pattern}
    ORDER BY
      CASE WHEN LOWER(name) LIKE LOWER(${prefix}) THEN 0 ELSE 1 END,
      LENGTH(name) ASC
    LIMIT 1
  `;
  return fuzzyRows[0] ?? null;
}

export interface TradeRouteRow {
  commodity_id: number;
  commodity_name: string;
  commodity_category: string;
  from_system: string;
  from_station: string;
  from_market_id: string;
  from_station_type: string | null;
  from_is_carrier: boolean;
  from_pad: LandingPadSize;
  from_ls: number | null;
  from_faction: string | null;
  buy_price: number;
  stock: number;
  buy_updated_at: Date | string;
  to_system: string;
  to_station: string;
  to_market_id: string;
  to_station_type: string | null;
  to_is_carrier: boolean;
  to_pad: LandingPadSize;
  to_ls: number | null;
  to_faction: string | null;
  to_faction_state: string | null;
  sell_price: number;
  demand: number;
  demand_bracket: number | null;
  sell_updated_at: Date | string;
  profit_per_ton: number;
  distance_ly: number | null;
}

export interface FindProfitableTradeRoutesParams {
  fromSystem: string;
  fromStation?: string | null;
  toSystem?: string | null;
  toStation?: string | null;
  maxDistanceLy?: number;
  minPad?: PadFilter;
  minStock?: number;
  minDemand?: number;
  maxLs?: number | null;
  includeCarriers?: boolean;
  limit?: number;
}

/**
 * Finds the most profitable commodity trade routes between two systems/stations or
 * from an origin system/station to any destination within `maxDistanceLy` Light Years.
 */
export async function findProfitableTradeRoutes(
  params: FindProfitableTradeRoutesParams,
): Promise<{ origin: ResolvedSystemInfo | null; routes: TradeRouteRow[] }> {
  const origin = await findOrResolveSystem(params.fromSystem);
  if (!origin) {
    return { origin: null, routes: [] };
  }

  let destination: ResolvedSystemInfo | null = null;
  if (params.toSystem?.trim()) {
    destination = await findOrResolveSystem(params.toSystem);
    if (!destination) {
      return { origin, routes: [] };
    }
  }

  const maxDistanceLy = params.maxDistanceLy ?? 50;
  const minPad = params.minPad ?? "L";
  const minStock = params.minStock ?? 500;
  const minDemand = params.minDemand ?? 0;
  const maxLs = params.maxLs ?? null;
  const includeCarriers = params.includeCarriers ?? false;
  const limit = Math.min(50, Math.max(1, params.limit ?? 25));

  const fromStationFilter = params.fromStation?.trim() || null;
  const toStationFilter = params.toStation?.trim() || null;
  const toSystemId = destination?.id ?? null;

  const hasOriginCoords = origin.x !== null && origin.y !== null && origin.z !== null;

  const rows = await sql<TradeRouteRow[]>`
    SELECT
      c.id AS commodity_id,
      c.name AS commodity_name,
      c.category AS commodity_category,
      sys_from.name AS from_system,
      st_from.name AS from_station,
      st_from.market_id::text AS from_market_id,
      st_from.station_type AS from_station_type,
      st_from.is_fleet_carrier AS from_is_carrier,
      st_from.max_landing_pad AS from_pad,
      st_from.distance_to_arrival_ls AS from_ls,
      st_from.controlling_faction AS from_faction,
      buy.buy_price,
      buy.stock,
      buy.updated_at AS buy_updated_at,
      sys_to.name AS to_system,
      st_to.name AS to_station,
      st_to.market_id::text AS to_market_id,
      st_to.station_type AS to_station_type,
      st_to.is_fleet_carrier AS to_is_carrier,
      st_to.max_landing_pad AS to_pad,
      st_to.distance_to_arrival_ls AS to_ls,
      st_to.controlling_faction AS to_faction,
      st_to.controlling_faction_state AS to_faction_state,
      sell.sell_price,
      sell.demand,
      sell.demand_bracket,
      sell.updated_at AS sell_updated_at,
      (sell.sell_price - buy.buy_price)::int AS profit_per_ton,
      CASE
        WHEN sys_from.x IS NOT NULL AND sys_to.x IS NOT NULL
        THEN (cube(ARRAY[sys_from.x, sys_from.y, sys_from.z]) <-> cube(ARRAY[sys_to.x, sys_to.y, sys_to.z]))::float8
        ELSE NULL
      END AS distance_ly
    FROM stations st_from
    JOIN systems sys_from ON sys_from.id = st_from.system_id
    JOIN market_listings buy ON buy.market_id = st_from.market_id
    JOIN market_listings sell
      ON sell.commodity_id = buy.commodity_id
     AND sell.sell_price > buy.buy_price
     AND sell.market_id <> buy.market_id
    JOIN stations st_to ON st_to.market_id = sell.market_id
    JOIN systems sys_to ON sys_to.id = st_to.system_id
    JOIN commodities c ON c.id = buy.commodity_id
    WHERE sys_from.id = ${origin.id}
      AND (${fromStationFilter}::text IS NULL OR LOWER(st_from.name) = LOWER(${fromStationFilter}))
      AND buy.buy_price > 0
      AND buy.stock >= ${minStock}
      AND sell.demand >= ${minDemand}
      AND (
        (${toSystemId}::bigint IS NOT NULL AND sys_to.id = ${toSystemId}::bigint)
        OR (
          ${toSystemId}::bigint IS NULL
          AND (
            sys_to.id = sys_from.id
            OR (
              ${hasOriginCoords} = true
              AND sys_to.x IS NOT NULL
              AND cube_enlarge(cube(ARRAY[${origin.x ?? 0}::float8, ${origin.y ?? 0}::float8, ${origin.z ?? 0}::float8]), ${maxDistanceLy}::float8, 3)
                  @> cube(ARRAY[sys_to.x, sys_to.y, sys_to.z])
              AND (cube(ARRAY[${origin.x ?? 0}::float8, ${origin.y ?? 0}::float8, ${origin.z ?? 0}::float8]) <-> cube(ARRAY[sys_to.x, sys_to.y, sys_to.z])) <= ${maxDistanceLy}::float8
            )
          )
        )
      )
      AND (${toStationFilter}::text IS NULL OR LOWER(st_to.name) = LOWER(${toStationFilter}))
      AND (
        ${minPad} = 'Any'
        OR (${minPad} = 'L' AND st_from.max_landing_pad = 'L' AND st_to.max_landing_pad = 'L')
        OR (${minPad} = 'M' AND st_from.max_landing_pad IN ('M', 'L') AND st_to.max_landing_pad IN ('M', 'L'))
      )
      AND (
        ${maxLs}::float8 IS NULL
        OR (
          COALESCE(st_from.distance_to_arrival_ls, 0) <= ${maxLs}::float8
          AND COALESCE(st_to.distance_to_arrival_ls, 0) <= ${maxLs}::float8
        )
      )
      AND (
        ${includeCarriers} = true
        OR (st_from.is_fleet_carrier = false AND st_to.is_fleet_carrier = false)
      )
      AND (
        st_from.is_fleet_carrier = false
        OR COALESCE(st_from.carrier_docking_access, 'all') = 'all'
      )
      AND (
        st_to.is_fleet_carrier = false
        OR COALESCE(st_to.carrier_docking_access, 'all') = 'all'
      )
    ORDER BY profit_per_ton DESC, distance_ly ASC NULLS LAST
    LIMIT ${limit}
  `;

  return { origin, routes: rows };
}

export interface FindInternalTradeRoutesParams {
  system: string;
  fromStation?: string | null;
  toStation?: string | null;
  commodityQuery?: string | null;
  toFaction?: string | null;
  minPad?: PadFilter;
  minStock?: number;
  minDemand?: number;
  maxLs?: number | null;
  includeCarriers?: boolean;
  limit?: number;
}

/**
 * Finds the most profitable internal (in-system) commodity trade routes between
 * markets located within the same star system.
 */
export async function findInternalTradeRoutes(
  params: FindInternalTradeRoutesParams,
): Promise<{
  system: ResolvedSystemInfo | null;
  commodity: ResolvedCommodityInfo | null;
  routes: TradeRouteRow[];
}> {
  const system = await findOrResolveSystem(params.system);
  if (!system) {
    return { system: null, commodity: null, routes: [] };
  }

  let commodity: ResolvedCommodityInfo | null = null;
  if (params.commodityQuery?.trim()) {
    commodity = await resolveCommodityByQuery(params.commodityQuery);
    if (!commodity) {
      return { system, commodity: null, routes: [] };
    }
  }

  const minPad = params.minPad ?? "L";
  const minStock = params.minStock ?? 500;
  const minDemand = params.minDemand ?? 0;
  const maxLs = params.maxLs ?? null;
  const includeCarriers = params.includeCarriers ?? false;
  const limit = Math.min(50, Math.max(1, params.limit ?? 25));

  const fromStationFilter = params.fromStation?.trim() || null;
  const toStationFilter = params.toStation?.trim() || null;
  const toFactionFilter = params.toFaction?.trim() || null;
  const commodityId = commodity?.id ?? null;

  const rows = await sql<TradeRouteRow[]>`
    SELECT
      c.id AS commodity_id,
      c.name AS commodity_name,
      c.category AS commodity_category,
      ${system.name}::text AS from_system,
      st_from.name AS from_station,
      st_from.market_id::text AS from_market_id,
      st_from.station_type AS from_station_type,
      st_from.is_fleet_carrier AS from_is_carrier,
      st_from.max_landing_pad AS from_pad,
      st_from.distance_to_arrival_ls AS from_ls,
      st_from.controlling_faction AS from_faction,
      buy.buy_price,
      buy.stock,
      buy.updated_at AS buy_updated_at,
      ${system.name}::text AS to_system,
      st_to.name AS to_station,
      st_to.market_id::text AS to_market_id,
      st_to.station_type AS to_station_type,
      st_to.is_fleet_carrier AS to_is_carrier,
      st_to.max_landing_pad AS to_pad,
      st_to.distance_to_arrival_ls AS to_ls,
      st_to.controlling_faction AS to_faction,
      st_to.controlling_faction_state AS to_faction_state,
      sell.sell_price,
      sell.demand,
      sell.demand_bracket,
      sell.updated_at AS sell_updated_at,
      (sell.sell_price - buy.buy_price)::int AS profit_per_ton,
      0::float8 AS distance_ly
    FROM stations st_from
    JOIN market_listings buy ON buy.market_id = st_from.market_id
    JOIN market_listings sell
      ON sell.commodity_id = buy.commodity_id
     AND sell.sell_price > buy.buy_price
     AND sell.market_id <> buy.market_id
    JOIN stations st_to ON st_to.market_id = sell.market_id
    JOIN commodities c ON c.id = buy.commodity_id
    WHERE st_from.system_id = ${system.id}
      AND st_to.system_id = ${system.id}
      AND (${fromStationFilter}::text IS NULL OR LOWER(st_from.name) = LOWER(${fromStationFilter}))
      AND (${toStationFilter}::text IS NULL OR LOWER(st_to.name) = LOWER(${toStationFilter}))
      AND (${toFactionFilter}::text IS NULL OR LOWER(st_to.controlling_faction) = LOWER(${toFactionFilter}))
      AND (${commodityId}::int IS NULL OR c.id = ${commodityId}::int)
      AND buy.buy_price > 0
      AND buy.stock >= ${minStock}
      AND sell.demand >= ${minDemand}
      AND (
        ${minPad} = 'Any'
        OR (${minPad} = 'L' AND st_from.max_landing_pad = 'L' AND st_to.max_landing_pad = 'L')
        OR (${minPad} = 'M' AND st_from.max_landing_pad IN ('M', 'L') AND st_to.max_landing_pad IN ('M', 'L'))
      )
      AND (
        ${maxLs}::float8 IS NULL
        OR (
          COALESCE(st_from.distance_to_arrival_ls, 0) <= ${maxLs}::float8
          AND COALESCE(st_to.distance_to_arrival_ls, 0) <= ${maxLs}::float8
        )
      )
      AND (
        ${includeCarriers} = true
        OR (st_from.is_fleet_carrier = false AND st_to.is_fleet_carrier = false)
      )
      AND (
        st_from.is_fleet_carrier = false
        OR COALESCE(st_from.carrier_docking_access, 'all') = 'all'
      )
      AND (
        st_to.is_fleet_carrier = false
        OR COALESCE(st_to.carrier_docking_access, 'all') = 'all'
      )
    ORDER BY
      profit_per_ton DESC,
      (COALESCE(st_from.distance_to_arrival_ls, 0) + COALESCE(st_to.distance_to_arrival_ls, 0)) ASC,
      buy.stock DESC
    LIMIT ${limit}
  `;

  return { system, commodity, routes: rows };
}

export type UndermineStrategy = "budget_loss" | "heavy_loss";

export interface UndermineRouteRow {
  commodity_id: number;
  commodity_name: string;
  commodity_category: string;
  from_system: string;
  from_station: string;
  from_pad: LandingPadSize;
  from_ls: number | null;
  from_is_carrier: boolean;
  buy_price: number;
  stock: number;
  buy_updated_at: Date | string;
  target_system: string;
  target_station: string;
  target_station_type: string | null;
  target_pad: LandingPadSize;
  target_ls: number | null;
  target_faction: string | null;
  target_faction_state: string | null;
  sell_price: number;
  demand: number;
  demand_bracket: number | null;
  sell_updated_at: Date | string;
  loss_per_ton: number;
  distance_ly: number | null;
}

export interface FindUndermineRoutesParams {
  targetSystem?: string | null;
  targetStation?: string | null;
  targetFaction?: string | null;
  maxDistanceLy?: number;
  strategy?: UndermineStrategy;
  maxLossPerTon?: number | null;
  minStock?: number;
  minPad?: PadFilter;
  maxLs?: number | null;
  includeSourceCarriers?: boolean;
  limit?: number;
}

/**
 * Finds loss trade routes (`sell_price < buy_price`) targeting stations in a specific system,
 * a specific station, or any station controlled by a specific Minor Faction to undermine their BGS influence.
 * Automatically excludes Fleet Carriers and Colonisation Vessels as targets since they have no BGS faction influence.
 */
export async function findUndermineLossRoutes(
  params: FindUndermineRoutesParams,
): Promise<UndermineRouteRow[]> {
  const targetSystem = params.targetSystem?.trim() || null;
  const targetStation = params.targetStation?.trim() || null;
  const targetFaction = params.targetFaction?.trim() || null;

  if (!targetSystem && !targetStation && !targetFaction) {
    return [];
  }

  if (targetSystem) {
    await findOrResolveSystem(targetSystem);
  }

  const maxDistanceLy = params.maxDistanceLy ?? 40;
  const strategy = params.strategy ?? "budget_loss";
  const maxLossPerTon = params.maxLossPerTon ?? null;
  const minStock = params.minStock ?? 1000;
  const minPad = params.minPad ?? "L";
  const maxLs = params.maxLs ?? null;
  const includeSourceCarriers = params.includeSourceCarriers ?? false;
  const limit = Math.min(50, Math.max(1, params.limit ?? 25));

  return await sql<UndermineRouteRow[]>`
    SELECT
      c.id AS commodity_id,
      c.name AS commodity_name,
      c.category AS commodity_category,
      sys_from.name AS from_system,
      st_from.name AS from_station,
      st_from.max_landing_pad AS from_pad,
      st_from.distance_to_arrival_ls AS from_ls,
      st_from.is_fleet_carrier AS from_is_carrier,
      buy.buy_price,
      buy.stock,
      buy.updated_at AS buy_updated_at,
      sys_to.name AS target_system,
      st_to.name AS target_station,
      st_to.station_type AS target_station_type,
      st_to.max_landing_pad AS target_pad,
      st_to.distance_to_arrival_ls AS target_ls,
      st_to.controlling_faction AS target_faction,
      st_to.controlling_faction_state AS target_faction_state,
      sell.sell_price,
      sell.demand,
      sell.demand_bracket,
      sell.updated_at AS sell_updated_at,
      (buy.buy_price - sell.sell_price)::int AS loss_per_ton,
      CASE
        WHEN sys_from.x IS NOT NULL AND sys_to.x IS NOT NULL
        THEN (cube(ARRAY[sys_from.x, sys_from.y, sys_from.z]) <-> cube(ARRAY[sys_to.x, sys_to.y, sys_to.z]))::float8
        ELSE NULL
      END AS distance_ly
    FROM stations st_to
    JOIN systems sys_to ON sys_to.id = st_to.system_id
    JOIN market_listings sell ON sell.market_id = st_to.market_id
    JOIN market_listings buy
      ON buy.commodity_id = sell.commodity_id
     AND buy.buy_price > sell.sell_price
     AND buy.market_id <> sell.market_id
    JOIN stations st_from ON st_from.market_id = buy.market_id
    JOIN systems sys_from ON sys_from.id = st_from.system_id
    JOIN commodities c ON c.id = sell.commodity_id
    WHERE st_to.is_fleet_carrier = false
      AND st_to.is_colonisation_vessel = false
      AND (${targetSystem}::text IS NULL OR LOWER(sys_to.name) = LOWER(${targetSystem}))
      AND (${targetStation}::text IS NULL OR LOWER(st_to.name) = LOWER(${targetStation}))
      AND (${targetFaction}::text IS NULL OR LOWER(st_to.controlling_faction) = LOWER(${targetFaction}))
      AND sell.sell_price > 0
      AND buy.buy_price > 0
      AND buy.stock >= ${minStock}
      AND (
        ${maxLossPerTon}::int IS NULL
        OR (buy.buy_price - sell.sell_price) <= ${maxLossPerTon}::int
      )
      AND (
        sys_from.id = sys_to.id
        OR (
          sys_to.x IS NOT NULL
          AND sys_from.x IS NOT NULL
          AND cube_enlarge(cube(ARRAY[sys_to.x, sys_to.y, sys_to.z]), ${maxDistanceLy}::float8, 3)
              @> cube(ARRAY[sys_from.x, sys_from.y, sys_from.z])
          AND (cube(ARRAY[sys_to.x, sys_to.y, sys_to.z]) <-> cube(ARRAY[sys_from.x, sys_from.y, sys_from.z])) <= ${maxDistanceLy}::float8
        )
      )
      AND (
        ${minPad} = 'Any'
        OR (${minPad} = 'L' AND st_from.max_landing_pad = 'L' AND st_to.max_landing_pad = 'L')
        OR (${minPad} = 'M' AND st_from.max_landing_pad IN ('M', 'L') AND st_to.max_landing_pad IN ('M', 'L'))
      )
      AND (
        ${maxLs}::float8 IS NULL
        OR (
          COALESCE(st_from.distance_to_arrival_ls, 0) <= ${maxLs}::float8
          AND COALESCE(st_to.distance_to_arrival_ls, 0) <= ${maxLs}::float8
        )
      )
      AND (
        ${includeSourceCarriers} = true
        OR st_from.is_fleet_carrier = false
      )
      AND (
        st_from.is_fleet_carrier = false
        OR COALESCE(st_from.carrier_docking_access, 'all') = 'all'
      )
    ORDER BY
      CASE WHEN ${strategy} = 'budget_loss' THEN (buy.buy_price - sell.sell_price) END ASC,
      CASE WHEN ${strategy} = 'heavy_loss' THEN (buy.buy_price - sell.sell_price) END DESC,
      distance_ly ASC NULLS LAST,
      buy.stock DESC
    LIMIT ${limit}
  `;
}

export interface CommodityListingRow {
  market_id: string;
  station_name: string;
  station_type: string | null;
  is_fleet_carrier: boolean;
  is_colonisation_vessel: boolean;
  max_landing_pad: LandingPadSize;
  distance_to_arrival_ls: number | null;
  controlling_faction: string | null;
  controlling_faction_state: string | null;
  system_name: string;
  mean_price: number;
  buy_price: number;
  stock: number;
  stock_bracket: number | null;
  sell_price: number;
  demand: number;
  demand_bracket: number | null;
  updated_at: Date | string;
  distance_ly: number | null;
}

export interface FindCommodityPriceParams {
  commodityQuery: string;
  nearSystem?: string | null;
  maxDistanceLy?: number | null;
  minQuantity?: number;
  minPad?: PadFilter;
  maxLs?: number | null;
  includeCarriers?: boolean;
  sortBy?: "price" | "distance";
  limit?: number;
}

/**
 * Finds the cheapest recorded buying prices (`buy_price > 0 AND stock >= minQuantity`)
 * for a commodity across the galaxy or within `maxDistanceLy` of `nearSystem`.
 */
export async function findCheapestCommodityBuy(params: FindCommodityPriceParams): Promise<{
  commodity: ResolvedCommodityInfo | null;
  referenceSystem: ResolvedSystemInfo | null;
  listings: CommodityListingRow[];
}> {
  const commodity = await resolveCommodityByQuery(params.commodityQuery);
  if (!commodity) {
    return { commodity: null, referenceSystem: null, listings: [] };
  }

  let referenceSystem: ResolvedSystemInfo | null = null;
  if (params.nearSystem?.trim()) {
    referenceSystem = await findOrResolveSystem(params.nearSystem);
  }

  const hasRefCoords =
    referenceSystem !== null &&
    referenceSystem.x !== null &&
    referenceSystem.y !== null &&
    referenceSystem.z !== null;

  const maxDist = params.maxDistanceLy ?? null;
  const minStock = params.minQuantity ?? 100;
  const minPad = params.minPad ?? "Any";
  const maxLs = params.maxLs ?? null;
  const includeCarriers = params.includeCarriers ?? true;
  const sortBy = params.sortBy ?? "price";
  const limit = Math.min(50, Math.max(1, params.limit ?? 25));

  const rows = await sql<CommodityListingRow[]>`
    SELECT
      st.market_id::text AS market_id,
      st.name AS station_name,
      st.station_type,
      st.is_fleet_carrier,
      st.is_colonisation_vessel,
      st.max_landing_pad,
      st.distance_to_arrival_ls,
      st.controlling_faction,
      st.controlling_faction_state,
      sys.name AS system_name,
      ml.mean_price,
      ml.buy_price,
      ml.stock,
      ml.stock_bracket,
      ml.sell_price,
      ml.demand,
      ml.demand_bracket,
      ml.updated_at,
      CASE
        WHEN ${hasRefCoords} = true AND sys.x IS NOT NULL
        THEN (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))::float8
        ELSE NULL
      END AS distance_ly
    FROM market_listings ml
    JOIN stations st ON st.market_id = ml.market_id
    JOIN systems sys ON sys.id = st.system_id
    WHERE ml.commodity_id = ${commodity.id}
      AND ml.buy_price > 0
      AND ml.stock >= ${minStock}
      AND (
        ${maxDist}::float8 IS NULL
        OR ${hasRefCoords} = false
        OR (
          sys.x IS NOT NULL
          AND cube_enlarge(cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]), ${maxDist}::float8, 3)
              @> cube(ARRAY[sys.x, sys.y, sys.z])
          AND (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z])) <= ${maxDist}::float8
        )
      )
      AND (
        ${minPad} = 'Any'
        OR (${minPad} = 'L' AND st.max_landing_pad = 'L')
        OR (${minPad} = 'M' AND st.max_landing_pad IN ('M', 'L'))
      )
      AND (
        ${maxLs}::float8 IS NULL
        OR COALESCE(st.distance_to_arrival_ls, 0) <= ${maxLs}::float8
      )
      AND (
        ${includeCarriers} = true
        OR st.is_fleet_carrier = false
      )
      AND (
        st.is_fleet_carrier = false
        OR COALESCE(st.carrier_docking_access, 'all') = 'all'
      )
    ORDER BY
      CASE WHEN ${sortBy} = 'distance' AND ${hasRefCoords} = true THEN
        (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))
      END ASC NULLS LAST,
      ml.buy_price ASC,
      distance_ly ASC NULLS LAST,
      ml.stock DESC
    LIMIT ${limit}
  `;

  return { commodity, referenceSystem, listings: rows };
}

/**
 * Finds the highest recorded selling prices (`sell_price > 0 AND demand >= minQuantity`)
 * for a commodity across the galaxy or within `maxDistanceLy` of `nearSystem`.
 */
export async function findHighestCommoditySell(params: FindCommodityPriceParams): Promise<{
  commodity: ResolvedCommodityInfo | null;
  referenceSystem: ResolvedSystemInfo | null;
  listings: CommodityListingRow[];
}> {
  const commodity = await resolveCommodityByQuery(params.commodityQuery);
  if (!commodity) {
    return { commodity: null, referenceSystem: null, listings: [] };
  }

  let referenceSystem: ResolvedSystemInfo | null = null;
  if (params.nearSystem?.trim()) {
    referenceSystem = await findOrResolveSystem(params.nearSystem);
  }

  const hasRefCoords =
    referenceSystem !== null &&
    referenceSystem.x !== null &&
    referenceSystem.y !== null &&
    referenceSystem.z !== null;

  const maxDist = params.maxDistanceLy ?? null;
  const minDemand = params.minQuantity ?? 1;
  const minPad = params.minPad ?? "Any";
  const maxLs = params.maxLs ?? null;
  const includeCarriers = params.includeCarriers ?? true;
  const sortBy = params.sortBy ?? "price";
  const limit = Math.min(50, Math.max(1, params.limit ?? 25));

  const rows = await sql<CommodityListingRow[]>`
    SELECT
      st.market_id::text AS market_id,
      st.name AS station_name,
      st.station_type,
      st.is_fleet_carrier,
      st.is_colonisation_vessel,
      st.max_landing_pad,
      st.distance_to_arrival_ls,
      st.controlling_faction,
      st.controlling_faction_state,
      sys.name AS system_name,
      ml.mean_price,
      ml.buy_price,
      ml.stock,
      ml.stock_bracket,
      ml.sell_price,
      ml.demand,
      ml.demand_bracket,
      ml.updated_at,
      CASE
        WHEN ${hasRefCoords} = true AND sys.x IS NOT NULL
        THEN (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))::float8
        ELSE NULL
      END AS distance_ly
    FROM market_listings ml
    JOIN stations st ON st.market_id = ml.market_id
    JOIN systems sys ON sys.id = st.system_id
    WHERE ml.commodity_id = ${commodity.id}
      AND ml.sell_price > 0
      AND ml.demand >= ${minDemand}
      AND (
        ${maxDist}::float8 IS NULL
        OR ${hasRefCoords} = false
        OR (
          sys.x IS NOT NULL
          AND cube_enlarge(cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]), ${maxDist}::float8, 3)
              @> cube(ARRAY[sys.x, sys.y, sys.z])
          AND (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z])) <= ${maxDist}::float8
        )
      )
      AND (
        ${minPad} = 'Any'
        OR (${minPad} = 'L' AND st.max_landing_pad = 'L')
        OR (${minPad} = 'M' AND st.max_landing_pad IN ('M', 'L'))
      )
      AND (
        ${maxLs}::float8 IS NULL
        OR COALESCE(st.distance_to_arrival_ls, 0) <= ${maxLs}::float8
      )
      AND (
        ${includeCarriers} = true
        OR st.is_fleet_carrier = false
      )
      AND (
        st.is_fleet_carrier = false
        OR COALESCE(st.carrier_docking_access, 'all') = 'all'
      )
    ORDER BY
      CASE WHEN ${sortBy} = 'distance' AND ${hasRefCoords} = true THEN
        (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))
      END ASC NULLS LAST,
      ml.sell_price DESC,
      distance_ly ASC NULLS LAST,
      ml.demand DESC
    LIMIT ${limit}
  `;

  return { commodity, referenceSystem, listings: rows };
}

export interface FactionMarketRow {
  market_id: string;
  station_name: string;
  station_type: string | null;
  max_landing_pad: LandingPadSize;
  distance_to_arrival_ls: number | null;
  has_blackmarket: boolean;
  controlling_faction: string;
  controlling_faction_state: string | null;
  primary_economy: string | null;
  system_name: string;
  system_security: string | null;
  faction_influence: number | null;
  listings_count: number;
  market_updated_at: Date | string | null;
  updated_at: Date | string;
}

/**
 * Lists all known stations controlled by a specific Minor Faction, enriched with
 * system BGS influence %, Black Market availability, and commodity market freshness.
 */
export async function findFactionMarkets(
  factionName: string,
  systemFilter?: string | null,
  limit = 30,
): Promise<FactionMarketRow[]> {
  const faction = factionName.trim();
  const sysFilter = systemFilter?.trim() || null;
  const safeLimit = Math.min(50, Math.max(1, limit));

  return await sql<FactionMarketRow[]>`
    SELECT
      st.market_id::text AS market_id,
      st.name AS station_name,
      st.station_type,
      st.max_landing_pad,
      st.distance_to_arrival_ls,
      st.has_blackmarket,
      st.controlling_faction,
      COALESCE(st.controlling_faction_state, sf.faction_state) AS controlling_faction_state,
      st.primary_economy,
      sys.name AS system_name,
      sys.security AS system_security,
      sf.influence AS faction_influence,
      (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id) AS listings_count,
      st.market_updated_at,
      st.updated_at
    FROM stations st
    JOIN systems sys ON sys.id = st.system_id
    LEFT JOIN factions f ON LOWER(f.name) = LOWER(st.controlling_faction)
    LEFT JOIN system_factions sf ON sf.system_id = sys.id AND sf.faction_id = f.id
    WHERE LOWER(st.controlling_faction) = LOWER(${faction})
      AND (${sysFilter}::text IS NULL OR LOWER(sys.name) = LOWER(${sysFilter}))
    ORDER BY
      sys.name ASC,
      COALESCE(st.distance_to_arrival_ls, 999999) ASC,
      st.name ASC
    LIMIT ${safeLimit}
  `;
}

export type MarketListingsFilter = "all" | "supply" | "demand";

export type MarketListingsSortBy =
  | "category"
  | "sell_price"
  | "buy_price"
  | "stock"
  | "demand"
  | "name";

export interface MarketStationInfo {
  market_id: string;
  station_name: string;
  station_type: string | null;
  is_fleet_carrier: boolean;
  is_colonisation_vessel: boolean;
  max_landing_pad: LandingPadSize;
  distance_to_arrival_ls: number | null;
  controlling_faction: string | null;
  controlling_faction_state: string | null;
  government: string | null;
  primary_economy: string | null;
  has_blackmarket: boolean;
  system_id: number;
  system_name: string;
  market_updated_at: Date | string | null;
  updated_at: Date | string;
  total_listings_count: number;
  supply_count: number;
  demand_count: number;
}

export interface MarketItemRow {
  commodity_id: number;
  commodity_symbol: string;
  commodity_name: string;
  commodity_category: string;
  is_rare: boolean;
  mean_price: number;
  buy_price: number;
  stock: number;
  stock_bracket: number | null;
  sell_price: number;
  demand: number;
  demand_bracket: number | null;
  status_flags: string[] | null;
  updated_at: Date | string;
}

export interface GetMarketListingsParams {
  station: string;
  system?: string | null;
  filter?: MarketListingsFilter;
  commodityQuery?: string | null;
  minStock?: number;
  minDemand?: number;
  sortBy?: MarketListingsSortBy;
  limit?: number;
}

/**
 * On-demand hydration of a station and its commodity market from Spansh when the station
 * is not yet present or has no market listings in PostgreSQL.
 */
async function hydrateStationMarketOnDemand(
  stationName: string,
  systemName?: string | null,
): Promise<void> {
  if (
    !env.edsmResolverEnabled ||
    stationName.startsWith("PPH_TEST_") ||
    systemName?.startsWith("PPH_TEST_")
  ) {
    return;
  }

  try {
    const filters: Record<string, unknown> = {
      name: { value: stationName },
    };
    if (systemName) {
      filters.system_name = { value: systemName };
    }

    const res = await fetch("https://spansh.co.uk/api/stations/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PPH-Trading-Computer/1.0",
      },
      body: JSON.stringify({
        filters,
        size: 5,
        page: 0,
      }),
      signal: AbortSignal.timeout(4_500),
    });

    if (!res.ok) return;

    const data = (await res.json()) as {
      results?: Array<{
        market_id?: number;
        name?: string;
        type?: string;
        system_name?: string;
        system_id64?: number;
        system_x?: number;
        system_y?: number;
        system_z?: number;
        system_population?: number;
        controlling_minor_faction?: string;
        distance_to_arrival?: number;
        small_pads?: number;
        medium_pads?: number;
        large_pads?: number;
        government?: string;
        primary_economy?: string;
        services?: Array<{ name?: string } | string>;
        market?: Array<{
          commodity?: string;
          buy_price?: number;
          supply?: number;
          sell_price?: number;
          demand?: number;
        }>;
        market_updated_at?: string;
        updated_at?: string;
      }>;
    };

    const results = data.results ?? [];
    if (results.length === 0) return;

    await initCommodityCache();
    const commodityRows = await sql<{ id: number; name: string; symbol: string }[]>`
      SELECT id, name, symbol FROM commodities
    `;
    const commodityByNameOrSymbol = new Map<string, number>();
    for (const row of commodityRows) {
      commodityByNameOrSymbol.set(row.name.toLowerCase(), Number(row.id));
      commodityByNameOrSymbol.set(row.symbol.toLowerCase(), Number(row.id));
    }

    const nowIso = new Date().toISOString();

    for (const st of results) {
      if (!st.market_id || !st.name || !st.system_name) continue;

      const marketUpdatedAt = st.market_updated_at || st.updated_at || nowIso;
      const colonisation = isColonisationVessel({
        stationName: st.name,
        stationType: st.type,
        government: st.government,
      });
      const carrier = !colonisation && isFleetCarrier(st.type, st.name);

      const sysRec = await upsertSystem({
        name: st.system_name,
        systemAddress: st.system_id64 ?? null,
        x: st.system_x ?? null,
        y: st.system_y ?? null,
        z: st.system_z ?? null,
        population: (st.system_population ?? 0) > 0 ? st.system_population : 1,
        isUnderColonisation: colonisation,
        updatedAt: marketUpdatedAt,
      });

      const cleanedName = cleanStationName(st.name);
      const pads = {
        Small: st.small_pads ?? 0,
        Medium: st.medium_pads ?? 0,
        Large: st.large_pads ?? 0,
      };
      const maxPad = inferMaxLandingPad(
        pads,
        st.type ?? (carrier ? "FleetCarrier" : null),
        colonisation,
      );

      const services: string[] = [];
      if (Array.isArray(st.services)) {
        for (const svc of st.services) {
          const sName = typeof svc === "string" ? svc : svc?.name;
          if (sName?.trim()) services.push(sName.trim().toLowerCase());
        }
      }
      const hasBlackmarket = services.some(
        (s) => s.includes("black market") || s.includes("blackmarket"),
      );

      await upsertStationMeta({
        marketId: st.market_id,
        systemId: sysRec.id,
        name: cleanedName,
        stationType: st.type ?? (carrier ? "FleetCarrier" : null),
        isFleetCarrier: carrier,
        isColonisationVessel: colonisation,
        maxLandingPad: maxPad,
        padSmall: st.small_pads ?? null,
        padMedium: st.medium_pads ?? null,
        padLarge: st.large_pads ?? null,
        distanceToArrivalLs: st.distance_to_arrival ?? null,
        controllingFaction:
          st.controlling_minor_faction &&
          st.controlling_minor_faction.toLowerCase() !== "fleetcarrier"
            ? st.controlling_minor_faction
            : null,
        government: cleanFdevToken(st.government),
        primaryEconomy: cleanFdevToken(st.primary_economy),
        hasBlackmarket,
        services: services.length > 0 ? services : null,
        metaUpdatedAt: marketUpdatedAt,
      });

      if (Array.isArray(st.market) && st.market.length > 0) {
        const items: MarketCommodityItem[] = [];
        for (const entry of st.market) {
          if (!entry.commodity) continue;
          const key = entry.commodity.trim().toLowerCase();
          let commodityId = commodityByNameOrSymbol.get(key);
          if (commodityId === undefined) {
            commodityId = await resolveCommodityId(entry.commodity);
            commodityByNameOrSymbol.set(key, commodityId);
          }

          items.push({
            commodityId,
            meanPrice: 0,
            buyPrice: Math.max(0, Math.trunc(entry.buy_price ?? 0)),
            stock: Math.max(0, Math.trunc(entry.supply ?? 0)),
            stockBracket: (entry.supply ?? 0) > 0 ? 2 : 0,
            sellPrice: Math.max(0, Math.trunc(entry.sell_price ?? 0)),
            demand: Math.max(0, Math.trunc(entry.demand ?? 0)),
            demandBracket: (entry.demand ?? 0) > 0 ? 2 : 0,
            statusFlags: null,
          });
        }

        await upsertStationMarket({
          marketId: st.market_id,
          systemId: sysRec.id,
          stationName: cleanedName,
          stationType: st.type ?? (carrier ? "FleetCarrier" : null),
          isFleetCarrier: carrier,
          isColonisationVessel: colonisation,
          maxLandingPad: maxPad,
          marketUpdatedAt,
          items,
        });
      }
    }
  } catch {
    // Ignore Spansh timeout/network errors
  }
}

/**
 * Resolves a specific market (station, outpost, settlement, or Fleet Carrier) by name
 * (and optional system filter) and returns its station metadata along with all matching
 * commodity listings.
 */
export async function getStationMarketListings(
  params: GetMarketListingsParams,
): Promise<{
  station: MarketStationInfo | null;
  listings: MarketItemRow[];
}> {
  const stationQuery = params.station.trim();
  if (!stationQuery) {
    return { station: null, listings: [] };
  }

  const systemFilter = params.system?.trim() || null;
  const filter: MarketListingsFilter = params.filter ?? "all";
  const commodityFilter = params.commodityQuery?.trim() || null;
  const minStock = Math.max(0, params.minStock ?? 0);
  const minDemand = Math.max(0, params.minDemand ?? 0);
  const sortBy: MarketListingsSortBy = params.sortBy ?? "category";
  const limit = Math.min(200, Math.max(1, params.limit ?? 150));

  const escapedStation = stationQuery.replace(/[\\%_]/g, "\\$&");
  const substringPattern = `%${escapedStation}%`;
  const prefixPattern = `${escapedStation}%`;

  const queryStation = async (): Promise<MarketStationInfo | null> => {
    const exactRows = await sql<MarketStationInfo[]>`
      SELECT
        st.market_id::text AS market_id,
        st.name AS station_name,
        st.station_type,
        st.is_fleet_carrier,
        st.is_colonisation_vessel,
        st.max_landing_pad,
        st.distance_to_arrival_ls,
        st.controlling_faction,
        st.controlling_faction_state,
        st.government,
        st.primary_economy,
        st.has_blackmarket,
        sys.id::int AS system_id,
        sys.name AS system_name,
        st.market_updated_at,
        st.updated_at,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id) AS total_listings_count,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id AND ml.buy_price > 0 AND ml.stock > 0) AS supply_count,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id AND ml.sell_price > 0 AND ml.demand > 0) AS demand_count
      FROM stations st
      JOIN systems sys ON sys.id = st.system_id
      WHERE (LOWER(st.name) = LOWER(${stationQuery}) OR st.market_id::text = ${stationQuery})
        AND (${systemFilter}::text IS NULL OR LOWER(sys.name) = LOWER(${systemFilter}))
      ORDER BY
        ((SELECT COUNT(*) FROM market_listings ml WHERE ml.market_id = st.market_id) > 0) DESC,
        st.is_fleet_carrier ASC,
        st.market_updated_at DESC NULLS LAST,
        st.updated_at DESC
      LIMIT 1
    `;
    if (exactRows[0]) return exactRows[0];

    const fuzzyRows = await sql<MarketStationInfo[]>`
      SELECT
        st.market_id::text AS market_id,
        st.name AS station_name,
        st.station_type,
        st.is_fleet_carrier,
        st.is_colonisation_vessel,
        st.max_landing_pad,
        st.distance_to_arrival_ls,
        st.controlling_faction,
        st.controlling_faction_state,
        st.government,
        st.primary_economy,
        st.has_blackmarket,
        sys.id::int AS system_id,
        sys.name AS system_name,
        st.market_updated_at,
        st.updated_at,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id) AS total_listings_count,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id AND ml.buy_price > 0 AND ml.stock > 0) AS supply_count,
        (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id AND ml.sell_price > 0 AND ml.demand > 0) AS demand_count
      FROM stations st
      JOIN systems sys ON sys.id = st.system_id
      WHERE st.name ILIKE ${substringPattern}
        AND (${systemFilter}::text IS NULL OR LOWER(sys.name) = LOWER(${systemFilter}))
      ORDER BY
        CASE WHEN LOWER(st.name) LIKE LOWER(${prefixPattern}) THEN 0 ELSE 1 END,
        ((SELECT COUNT(*) FROM market_listings ml WHERE ml.market_id = st.market_id) > 0) DESC,
        st.is_fleet_carrier ASC,
        LENGTH(st.name) ASC,
        st.market_updated_at DESC NULLS LAST
      LIMIT 1
    `;
    return fuzzyRows[0] ?? null;
  };

  let station = await queryStation();

  if (!station || station.total_listings_count === 0) {
    await hydrateStationMarketOnDemand(
      station?.station_name ?? stationQuery,
      station?.system_name ?? systemFilter,
    );
    station = await queryStation();
  }

  if (!station) {
    return { station: null, listings: [] };
  }

  const commodityPattern = commodityFilter
    ? `%${commodityFilter.replace(/[\\%_]/g, "\\$&")}%`
    : null;

  const listings = await sql<MarketItemRow[]>`
    SELECT
      c.id AS commodity_id,
      c.symbol AS commodity_symbol,
      c.name AS commodity_name,
      c.category AS commodity_category,
      c.is_rare,
      ml.mean_price,
      ml.buy_price,
      ml.stock,
      ml.stock_bracket,
      ml.sell_price,
      ml.demand,
      ml.demand_bracket,
      ml.status_flags,
      ml.updated_at
    FROM market_listings ml
    JOIN commodities c ON c.id = ml.commodity_id
    WHERE ml.market_id = ${station.market_id}::bigint
      AND (
        (${filter} = 'supply' AND ml.buy_price > 0 AND ml.stock >= ${Math.max(1, minStock)})
        OR (${filter} = 'demand' AND ml.sell_price > 0 AND ml.demand >= ${minDemand})
        OR (
          ${filter} = 'all'
          AND (${minStock} = 0 OR (ml.buy_price > 0 AND ml.stock >= ${minStock}))
          AND (${minDemand} = 0 OR (ml.sell_price > 0 AND ml.demand >= ${minDemand}))
        )
      )
      AND (
        ${commodityPattern}::text IS NULL
        OR c.name ILIKE ${commodityPattern}
        OR c.symbol ILIKE ${commodityPattern}
        OR c.category ILIKE ${commodityPattern}
      )
    ORDER BY
      CASE WHEN ${sortBy} = 'category' THEN c.category END ASC,
      CASE WHEN ${sortBy} = 'sell_price' THEN ml.sell_price END DESC,
      CASE WHEN ${sortBy} = 'buy_price' AND ml.buy_price > 0 THEN 0 WHEN ${sortBy} = 'buy_price' THEN 1 END ASC,
      CASE WHEN ${sortBy} = 'buy_price' THEN ml.buy_price END ASC,
      CASE WHEN ${sortBy} = 'stock' THEN ml.stock END DESC,
      CASE WHEN ${sortBy} = 'demand' THEN ml.demand END DESC,
      c.name ASC
    LIMIT ${limit}
  `;

  return { station, listings };
}
