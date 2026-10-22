import { env } from "../../config/env.ts";
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
  type FactionStateEntry,
  type NormalizedFactionInput,
  upsertStationMeta,
  upsertSystemFactions,
} from "./ingest.ts";
import { findOrResolveSystem, type ResolvedSystemInfo } from "./trading.ts";

export interface SystemBgsOverview {
  id: number;
  name: string;
  system_address: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  population: number | null;
  is_under_colonisation: boolean;
  allegiance: string | null;
  government: string | null;
  primary_economy: string | null;
  security: string | null;
  controlling_faction: string | null;
  controlling_power: string | null;
  powerplay_state: string | null;
  updated_at: Date | string;
}

export interface SystemFactionBgsRow {
  faction_id: number;
  name: string;
  allegiance: string | null;
  government: string | null;
  influence: number | null;
  faction_state: string | null;
  happiness: string | null;
  active_states: string[];
  pending_states: string[];
  recovering_states: string[];
  is_controlling: boolean;
  is_native: boolean;
  controlled_stations_count: number;
  updated_at: Date | string;
}

export interface SystemStationBgsRow {
  market_id: string;
  name: string;
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
  listings_count: number;
  market_updated_at: Date | string | null;
  updated_at: Date | string;
}

export interface SystemBgsReport {
  system: SystemBgsOverview | null;
  factions: SystemFactionBgsRow[];
  stations: SystemStationBgsRow[];
  fleetCarrierCount: number;
  alerts: string[];
}

const CONFLICT_STATES = new Set(["war", "civil war", "election"]);

/**
 * Safely extracts state names from a JSONB column (`FactionStateEntry[]` or JSON string).
 */
export function parseFactionStateNames(raw: unknown): string[] {
  if (!raw) return [];
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  }

  const names: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) {
      names.push(item.trim());
    } else if (item && typeof item === "object") {
      const obj = item as { State?: string; state?: string };
      const st = (obj.State ?? obj.state)?.trim();
      if (st && st.toLowerCase() !== "none") {
        names.push(st);
      }
    }
  }
  return Array.from(new Set(names));
}

/**
 * Infers whether a minor faction is native to the given star system.
 * In Elite Dangerous, procedurally generated native factions include their home
 * system's name and cannot retreat from their home system.
 */
export function isNativeFactionToSystem(
  factionName: string,
  systemName: string,
  allStates?: Iterable<string>,
): boolean {
  if (allStates) {
    for (const st of allStates) {
      if (st.toLowerCase() === "retreat") {
        return false;
      }
    }
  }

  const cleanSys = systemName
    .replace(/^pph_test_/i, "")
    .trim()
    .toLowerCase();
  const cleanFac = factionName
    .replace(/^pph_test_/i, "")
    .trim()
    .toLowerCase();

  if (!cleanSys || !cleanFac) return false;

  const escapedSys = cleanSys.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundaryRegex = new RegExp(`(?:^|[^a-z0-9])${escapedSys}(?:$|[^a-z0-9])`, "i");
  return boundaryRegex.test(cleanFac);
}

/**
 * Computes tactical BGS alerts for a system's minor faction standings.
 */
export function buildSystemBgsAlerts(
  system: SystemBgsOverview,
  factions: SystemFactionBgsRow[],
): string[] {
  const alerts: string[] = [];

  for (const f of factions) {
    const infPct = f.influence !== null ? f.influence * 100 : null;
    const allStates = new Set(
      [
        ...(f.faction_state ? [f.faction_state] : []),
        ...f.active_states,
        ...f.pending_states,
      ].map((s) => s.toLowerCase()),
    );

    // 1. Active or Pending Conflicts
    for (const cs of CONFLICT_STATES) {
      if (allStates.has(cs)) {
        const label = cs.replace(/\b\w/g, (c) => c.toUpperCase());
        const isPending =
          f.pending_states.some((s) => s.toLowerCase() === cs) &&
          !f.active_states.some((s) => s.toLowerCase() === cs) &&
          f.faction_state?.toLowerCase() !== cs;
        alerts.push(
          `⚔️ **${isPending ? `Pending ${label}` : label}**: **${f.name}** (${infPct !== null ? `${infPct.toFixed(1)}%` : "?%"})`,
        );
      }
    }

    // 2. Expansion Threshold (>= 75%)
    if (infPct !== null && infPct >= 75.0) {
      alerts.push(
        `🚀 **Expansion Threshold**: **${f.name}** is at **${infPct.toFixed(1)}% INF** (≥ 75%)`,
      );
    }

    // 3. Retreat Risk (<= 7.5% and > 0%, non-native factions only)
    if (!f.is_native && infPct !== null && infPct > 0 && infPct <= 7.5) {
      alerts.push(
        `⚠️ **Retreat Risk**: **${f.name}** is down to **${infPct.toFixed(1)}% INF** (≤ 7.5%)`,
      );
    }
  }

  // 4. Close Influence Gaps (< 5.0% difference between adjacent factions)
  const ranked = factions.filter((f) => f.influence !== null && f.influence > 0);
  for (let i = 0; i < ranked.length - 1; i++) {
    const upper = ranked[i]!;
    const lower = ranked[i + 1]!;
    const gapPct = ((upper.influence ?? 0) - (lower.influence ?? 0)) * 100;
    if (gapPct <= 5.0) {
      const controlNote =
        upper.is_controlling || lower.is_controlling ? " *(Control Contest!)*" : "";
      alerts.push(
        `🎯 **Close Influence Gap (${gapPct.toFixed(1)}%)**: **${upper.name}** (${((upper.influence ?? 0) * 100).toFixed(1)}%) vs **${lower.name}** (${((lower.influence ?? 0) * 100).toFixed(1)}%)${controlNote}`,
      );
    }
  }

  if (system.is_under_colonisation) {
    alerts.push("🏗️ **Active System Colonisation**: System has an active Colonisation Ship.");
  }

  return alerts;
}

/**
 * Fetches on-demand BGS factions and stations for a system from both Spansh (EDDN-backed)
 * and EDSM using their real upstream timestamps so PostgreSQL always retains the freshest snapshot.
 */
async function hydrateSystemBgsOnDemand(
  systemId: number,
  systemName: string,
): Promise<void> {
  if (!env.edsmResolverEnabled || systemName.startsWith("PPH_TEST_")) return;

  let systemAddress: string | null = null;
  try {
    const addrRows = await sql<{ system_address: string | null }[]>`
      SELECT system_address::text AS system_address
      FROM systems
      WHERE id = ${systemId}
      LIMIT 1
    `;
    systemAddress = addrRows[0]?.system_address ?? null;
  } catch {
    systemAddress = null;
  }

  // 1. Fetch EDSM factions (provides happiness, active/pending/recovering states, and unix lastUpdate)
  try {
    const factionsUrl = new URL("https://www.edsm.net/api-system-v1/factions");
    factionsUrl.searchParams.set("systemName", systemName);

    const res = await fetch(factionsUrl.toString(), {
      signal: AbortSignal.timeout(4_500),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        id64?: number;
        controllingFaction?: { name?: string };
        factions?: Array<{
          name?: string;
          allegiance?: string;
          government?: string;
          influence?: number;
          state?: string;
          happiness?: string;
          activeStates?: Array<{ state?: string; State?: string }>;
          pendingStates?: Array<{ state?: string; State?: string }>;
          recoveringStates?: Array<{ state?: string; State?: string }>;
          lastUpdate?: number;
        }>;
      };

      if (!systemAddress && data?.id64) {
        systemAddress = String(data.id64);
        await sql`
          UPDATE systems
          SET system_address = COALESCE(system_address, ${systemAddress}::bigint)
          WHERE id = ${systemId}
        `;
      }

      if (data?.controllingFaction?.name) {
        await sql`
          UPDATE systems
          SET controlling_faction = COALESCE(${data.controllingFaction.name}, controlling_faction)
          WHERE id = ${systemId}
        `;
      }

      if (Array.isArray(data?.factions) && data.factions.length > 0) {
        const activeFactions = data.factions.filter(
          (f) => f?.name && (f.influence ?? 0) > 0,
        );
        const maxLastUpdateSec = activeFactions.reduce(
          (max, f) => (typeof f.lastUpdate === "number" && f.lastUpdate > max ? f.lastUpdate : max),
          0,
        );
        const edsmUpdatedAtIso =
          maxLastUpdateSec > 0
            ? new Date(maxLastUpdateSec * 1000).toISOString()
            : new Date().toISOString();

        const normalized: NormalizedFactionInput[] = activeFactions.map((f) => {
          const mapStates = (
            arr?: Array<{ state?: string; State?: string }>,
          ): FactionStateEntry[] =>
            Array.isArray(arr)
              ? arr
                  .map((s) => cleanFdevToken(s.state ?? s.State) ?? s.state ?? s.State ?? "")
                  .filter((s) => Boolean(s && s !== "None"))
                  .map((State) => ({ State }))
              : [];

          return {
            name: f.name!.trim(),
            allegiance: cleanFdevToken(f.allegiance),
            government: cleanFdevToken(f.government),
            influence: typeof f.influence === "number" ? f.influence : null,
            factionState: cleanFdevToken(f.state),
            happiness: cleanFdevToken(f.happiness),
            activeStates: mapStates(f.activeStates),
            pendingStates: mapStates(f.pendingStates),
            recoveringStates: mapStates(f.recoveringStates),
          };
        });

        await upsertSystemFactions(systemId, normalized, edsmUpdatedAtIso);
      }
    }
  } catch {
    // Ignore EDSM network/timeout errors
  }

  // 2. Fetch Spansh direct system endpoint by id64 (ingests full live EDDN stream like Inara)
  if (systemAddress) {
    try {
      const spRes = await fetch(`https://spansh.co.uk/api/system/${systemAddress}`, {
        headers: { "User-Agent": "PPH-Trading-Computer/1.0" },
        signal: AbortSignal.timeout(4_500),
      });
      if (spRes.ok) {
        const spData = (await spRes.json()) as {
          record?: {
            updated_at?: string;
            controlling_minor_faction?: string;
            minor_faction_presences?: Array<{
              name?: string;
              allegiance?: string;
              government?: string;
              influence?: number;
              state?: string;
              active_states?: string[];
              pending_states?: string[];
              recovering_states?: string[];
            }>;
          };
        };
        const rec = spData?.record;
        if (rec && Array.isArray(rec.minor_faction_presences) && rec.minor_faction_presences.length > 0) {
          const spanshUpdatedAt = rec.updated_at || new Date().toISOString();
          const mapStrings = (arr?: string[]): FactionStateEntry[] =>
            Array.isArray(arr)
              ? arr
                  .map((s) => cleanFdevToken(s) ?? s)
                  .filter((s): s is string => Boolean(s && s !== "None"))
                  .map((State) => ({ State }))
              : [];

          const normalized: NormalizedFactionInput[] = rec.minor_faction_presences
            .filter((f) => f?.name && (f.influence ?? 0) > 0)
            .map((f) => {
              const active = mapStrings(f.active_states);
              if (active.length === 0 && f.state && f.state !== "None") {
                active.push({ State: cleanFdevToken(f.state) ?? f.state });
              }
              return {
                name: f.name!.trim(),
                allegiance: cleanFdevToken(f.allegiance),
                government: cleanFdevToken(f.government),
                influence: typeof f.influence === "number" ? f.influence : null,
                factionState: cleanFdevToken(f.state),
                happiness: null,
                activeStates: active,
                pendingStates: mapStrings(f.pending_states),
                recoveringStates: mapStrings(f.recovering_states),
              };
            });

          await upsertSystemFactions(systemId, normalized, spanshUpdatedAt);
        }
      }
    } catch {
      // Ignore Spansh timeout/network errors
    }
  }

  // 3. Also hydrate permanent stations from EDSM if none are recorded for this system yet
  try {
    const existingCount = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM stations WHERE system_id = ${systemId}
    `;
    if ((existingCount[0]?.count ?? 0) === 0) {
      const stationsUrl = new URL("https://www.edsm.net/api-system-v1/stations");
      stationsUrl.searchParams.set("systemName", systemName);
      const stRes = await fetch(stationsUrl.toString(), {
        signal: AbortSignal.timeout(4_500),
      });
      if (stRes.ok) {
        const stData = (await stRes.json()) as {
          stations?: Array<{
            marketId?: number;
            name?: string;
            type?: string;
            distanceToArrival?: number;
            government?: string;
            economy?: string;
            otherServices?: string[];
            controllingFaction?: { name?: string };
          }>;
        };

        if (Array.isArray(stData?.stations)) {
          const nowIso = new Date().toISOString();
          for (const st of stData.stations) {
            if (!st.marketId || !st.name) continue;
            const colonisation = isColonisationVessel({
              stationName: st.name,
              stationType: st.type,
              government: st.government,
            });
            const carrier = !colonisation && isFleetCarrier(st.type, st.name);
            if (carrier) continue;

            const cleanedName = cleanStationName(st.name);
            const maxPad = inferMaxLandingPad(undefined, st.type, colonisation);
            const services = Array.isArray(st.otherServices)
              ? st.otherServices.map((s) => s.toLowerCase())
              : null;
            const hasBlackmarket = services
              ? services.some((s) => s.includes("black market") || s.includes("blackmarket"))
              : false;

            await upsertStationMeta({
              marketId: st.marketId,
              systemId,
              name: cleanedName,
              stationType: st.type ?? null,
              isFleetCarrier: false,
              isColonisationVessel: colonisation,
              maxLandingPad: maxPad,
              distanceToArrivalLs: st.distanceToArrival ?? null,
              controllingFaction: st.controllingFaction?.name ?? null,
              government: cleanFdevToken(st.government),
              primaryEconomy: cleanFdevToken(st.economy),
              hasBlackmarket,
              services,
              metaUpdatedAt: nowIso,
            });
          }
        }
      }
    }
  } catch {
    // Ignore EDSM network/timeout errors
  }
}

/**
 * Generates a complete BGS & station infrastructure report for a star system.
 */
export async function getSystemBgsReport(systemName: string): Promise<SystemBgsReport> {
  const resolved = await findOrResolveSystem(systemName);
  if (!resolved) {
    return {
      system: null,
      factions: [],
      stations: [],
      fleetCarrierCount: 0,
      alerts: [],
    };
  }

  // Check local BGS freshness; if missing or older than 15 minutes, refresh on-demand from Spansh & EDSM
  const freshnessRows = await sql<{ count: number; latest_at: Date | string | null }[]>`
    SELECT
      COUNT(*)::int AS count,
      MAX(updated_at) AS latest_at
    FROM system_factions
    WHERE system_id = ${resolved.id}
  `;
  const count = freshnessRows[0]?.count ?? 0;
  const latestAt = freshnessRows[0]?.latest_at
    ? new Date(freshnessRows[0].latest_at).getTime()
    : 0;
  const isStale = Date.now() - latestAt > 15 * 60 * 1000;

  if ((count === 0 || isStale) && env.edsmResolverEnabled) {
    await hydrateSystemBgsOnDemand(resolved.id, resolved.name);
  }

  const sysRows = await sql<SystemBgsOverview[]>`
    SELECT
      id::int AS id,
      name,
      system_address::text AS system_address,
      x,
      y,
      z,
      population::bigint AS population,
      is_under_colonisation,
      allegiance,
      government,
      primary_economy,
      security,
      controlling_faction,
      controlling_power,
      powerplay_state,
      updated_at
    FROM systems
    WHERE id = ${resolved.id}
    LIMIT 1
  `;
  const system = sysRows[0] ?? null;
  if (!system) {
    return {
      system: null,
      factions: [],
      stations: [],
      fleetCarrierCount: 0,
      alerts: [],
    };
  }

  const rawFactions = await sql<
    Array<{
      faction_id: number;
      name: string;
      allegiance: string | null;
      government: string | null;
      influence: number | null;
      faction_state: string | null;
      happiness: string | null;
      active_states: unknown;
      pending_states: unknown;
      recovering_states: unknown;
      controlled_stations_count: number;
      updated_at: Date | string;
    }>
  >`
    SELECT
      f.id AS faction_id,
      f.name,
      f.allegiance,
      f.government,
      sf.influence,
      sf.faction_state,
      sf.happiness,
      sf.active_states,
      sf.pending_states,
      sf.recovering_states,
      (
        SELECT COUNT(*)::int
        FROM stations st
        WHERE st.system_id = ${system.id}
          AND st.is_fleet_carrier = false
          AND LOWER(st.controlling_faction) = LOWER(f.name)
      ) AS controlled_stations_count,
      sf.updated_at
    FROM system_factions sf
    JOIN factions f ON f.id = sf.faction_id
    WHERE sf.system_id = ${system.id}
    ORDER BY sf.influence DESC NULLS LAST, f.name ASC
  `;

  const factions: SystemFactionBgsRow[] = rawFactions.map((row) => {
    const activeStates = parseFactionStateNames(row.active_states);
    const pendingStates = parseFactionStateNames(row.pending_states);
    const recoveringStates = parseFactionStateNames(row.recovering_states);
    const allStates = [
      ...(row.faction_state ? [row.faction_state] : []),
      ...activeStates,
      ...pendingStates,
      ...recoveringStates,
    ];

    return {
      faction_id: row.faction_id,
      name: row.name,
      allegiance: row.allegiance,
      government: row.government,
      influence: row.influence,
      faction_state: row.faction_state,
      happiness: row.happiness,
      active_states: activeStates,
      pending_states: pendingStates,
      recovering_states: recoveringStates,
      is_controlling:
        Boolean(system.controlling_faction) &&
        row.name.toLowerCase() === system.controlling_faction!.toLowerCase(),
      is_native: isNativeFactionToSystem(row.name, system.name, allStates),
      controlled_stations_count: row.controlled_stations_count,
      updated_at: row.updated_at,
    };
  });

  const stations = await sql<SystemStationBgsRow[]>`
    SELECT
      st.market_id::text AS market_id,
      st.name,
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
      (SELECT COUNT(*)::int FROM market_listings ml WHERE ml.market_id = st.market_id) AS listings_count,
      st.market_updated_at,
      st.updated_at
    FROM stations st
    WHERE st.system_id = ${system.id}
      AND st.is_fleet_carrier = false
    ORDER BY
      st.is_colonisation_vessel ASC,
      COALESCE(st.distance_to_arrival_ls, 999999) ASC,
      st.name ASC
  `;

  const carrierRows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM stations
    WHERE system_id = ${system.id}
      AND is_fleet_carrier = true
  `;
  const fleetCarrierCount = carrierRows[0]?.count ?? 0;

  const alerts = buildSystemBgsAlerts(system, factions);

  return {
    system,
    factions,
    stations,
    fleetCarrierCount,
    alerts,
  };
}

export type FactionStatusSortBy = "influence" | "distance" | "population" | "name";

export interface FindFactionStatusParams {
  factionName: string;
  nearSystem?: string | null;
  maxDistanceLy?: number | null;
  stateFilter?: string | null;
  sortBy?: FactionStatusSortBy;
  limit?: number;
}

export interface FactionInfo {
  id: number;
  name: string;
  allegiance: string | null;
  government: string | null;
  updated_at: Date | string;
}

export interface FactionSystemPresenceRow {
  system_id: number;
  system_name: string;
  population: number | null;
  security: string | null;
  primary_economy: string | null;
  system_controlling_faction: string | null;
  is_controlling_system: boolean;
  influence: number | null;
  faction_state: string | null;
  happiness: string | null;
  active_states: string[];
  pending_states: string[];
  recovering_states: string[];
  controlled_stations_count: number;
  total_stations_count: number;
  rival_faction_name: string | null;
  rival_influence: number | null;
  distance_ly: number | null;
  updated_at: Date | string;
}

export interface FactionStatusReport {
  faction: FactionInfo | null;
  referenceSystem: ResolvedSystemInfo | null;
  presences: FactionSystemPresenceRow[];
}

/**
 * Resolves a minor faction by exact case-insensitive name or closest substring match,
 * and returns its multi-system BGS standings, states, station control counts, and rival margins.
 */
export async function getFactionStatusReport(
  params: FindFactionStatusParams,
): Promise<FactionStatusReport> {
  const q = params.factionName.trim();
  if (!q) {
    return { faction: null, referenceSystem: null, presences: [] };
  }

  let factionRows = await sql<FactionInfo[]>`
    SELECT id, name, allegiance, government, updated_at
    FROM factions
    WHERE LOWER(name) = LOWER(${q})
    LIMIT 1
  `;

  if (!factionRows[0]) {
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const prefix = `${q.replace(/[\\%_]/g, "\\$&")}%`;
    factionRows = await sql<FactionInfo[]>`
      SELECT id, name, allegiance, government, updated_at
      FROM factions
      WHERE name ILIKE ${pattern}
      ORDER BY
        CASE WHEN LOWER(name) LIKE LOWER(${prefix}) THEN 0 ELSE 1 END,
        LENGTH(name) ASC
      LIMIT 1
    `;
  }

  const faction = factionRows[0] ?? null;
  if (!faction) {
    return { faction: null, referenceSystem: null, presences: [] };
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
  const sortBy = params.sortBy ?? "influence";
  const limit = Math.min(50, Math.max(1, params.limit ?? 30));

  const rawRows = await sql<
    Array<{
      system_id: number;
      system_name: string;
      population: number | null;
      security: string | null;
      primary_economy: string | null;
      system_controlling_faction: string | null;
      influence: number | null;
      faction_state: string | null;
      happiness: string | null;
      active_states: unknown;
      pending_states: unknown;
      recovering_states: unknown;
      controlled_stations_count: number;
      total_stations_count: number;
      rival_faction_name: string | null;
      rival_influence: number | null;
      distance_ly: number | null;
      updated_at: Date | string;
    }>
  >`
    SELECT
      sys.id::int AS system_id,
      sys.name AS system_name,
      sys.population::bigint AS population,
      sys.security,
      sys.primary_economy,
      sys.controlling_faction AS system_controlling_faction,
      sf.influence,
      sf.faction_state,
      sf.happiness,
      sf.active_states,
      sf.pending_states,
      sf.recovering_states,
      (
        SELECT COUNT(*)::int
        FROM stations st
        WHERE st.system_id = sys.id
          AND st.is_fleet_carrier = false
          AND LOWER(st.controlling_faction) = LOWER(${faction.name})
      ) AS controlled_stations_count,
      (
        SELECT COUNT(*)::int
        FROM stations st
        WHERE st.system_id = sys.id
          AND st.is_fleet_carrier = false
      ) AS total_stations_count,
      rival.name AS rival_faction_name,
      rival.influence AS rival_influence,
      CASE
        WHEN ${hasRefCoords} = true AND sys.x IS NOT NULL
        THEN (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))::float8
        ELSE NULL
      END AS distance_ly,
      sf.updated_at
    FROM system_factions sf
    JOIN systems sys ON sys.id = sf.system_id
    LEFT JOIN LATERAL (
      SELECT f2.name, sf2.influence
      FROM system_factions sf2
      JOIN factions f2 ON f2.id = sf2.faction_id
      WHERE sf2.system_id = sys.id
        AND sf2.faction_id <> ${faction.id}
      ORDER BY
        ABS(COALESCE(sf2.influence, 0) - COALESCE(sf.influence, 0)) ASC,
        sf2.influence DESC NULLS LAST
      LIMIT 1
    ) rival ON true
    WHERE sf.faction_id = ${faction.id}
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
    ORDER BY
      CASE WHEN ${sortBy} = 'distance' AND ${hasRefCoords} = true THEN
        (cube(ARRAY[${referenceSystem?.x ?? 0}::float8, ${referenceSystem?.y ?? 0}::float8, ${referenceSystem?.z ?? 0}::float8]) <-> cube(ARRAY[sys.x, sys.y, sys.z]))
      END ASC NULLS LAST,
      CASE WHEN ${sortBy} = 'influence' THEN sf.influence END DESC NULLS LAST,
      CASE WHEN ${sortBy} = 'population' THEN sys.population END DESC NULLS LAST,
      sys.name ASC
    LIMIT ${limit}
  `;

  const stateFilterLower = params.stateFilter?.trim().toLowerCase() || null;

  let presences: FactionSystemPresenceRow[] = rawRows.map((row) => ({
    system_id: row.system_id,
    system_name: row.system_name,
    population: row.population,
    security: row.security,
    primary_economy: row.primary_economy,
    system_controlling_faction: row.system_controlling_faction,
    is_controlling_system:
      Boolean(row.system_controlling_faction) &&
      row.system_controlling_faction!.toLowerCase() === faction.name.toLowerCase(),
    influence: row.influence,
    faction_state: row.faction_state,
    happiness: row.happiness,
    active_states: parseFactionStateNames(row.active_states),
    pending_states: parseFactionStateNames(row.pending_states),
    recovering_states: parseFactionStateNames(row.recovering_states),
    controlled_stations_count: row.controlled_stations_count,
    total_stations_count: row.total_stations_count,
    rival_faction_name: row.rival_faction_name,
    rival_influence: row.rival_influence,
    distance_ly: row.distance_ly,
    updated_at: row.updated_at,
  }));

  if (stateFilterLower) {
    presences = presences.filter((p) => {
      const allStates = [
        ...(p.faction_state ? [p.faction_state] : []),
        ...p.active_states,
        ...p.pending_states,
        ...p.recovering_states,
      ].map((s) => s.toLowerCase());
      return allStates.some((s) => s.includes(stateFilterLower));
    });
  }

  return {
    faction,
    referenceSystem,
    presences,
  };
}
