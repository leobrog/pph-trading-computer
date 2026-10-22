import { env } from "../config/env.ts";
import { sql } from "../db/index.ts";
import { cleanFdevToken } from "./normalizer.ts";

interface SpanshSystemLookupResult {
  id64?: number;
  name?: string;
  x?: number;
  y?: number;
  z?: number;
  population?: number;
  is_being_colonised?: boolean;
  allegiance?: string;
  government?: string;
  primary_economy?: string;
  security?: string;
  controlling_minor_faction?: string;
  power?: string[] | string;
  power_state?: string;
}

interface EdsmSystemResponse {
  name?: string;
  id?: number;
  id64?: number;
  coords?: {
    x: number;
    y: number;
    z: number;
  };
  information?: {
    allegiance?: string;
    government?: string;
    faction?: string;
    factionState?: string;
    population?: number;
    security?: string;
    economy?: string;
  };
}

interface ResolvedExternalSystem {
  name: string;
  id64Str: string | null;
  coords: { x: number; y: number; z: number } | null;
  population: number;
  isBeingColonised: boolean;
  allegiance: string | null;
  government: string | null;
  economy: string | null;
  security: string | null;
  controllingFaction: string | null;
  controllingPower: string | null;
  powerplayState: string | null;
}

const pendingQueue: string[] = [];
const queuedOrResolved = new Set<string>();
const knownUninhabitedSystems = new Set<string>();
const MAX_CACHE_SIZE = 20_000;

let workerTimer: Timer | null = null;
let isProcessing = false;

/**
 * Checks whether a system name has already been confirmed by EDSM as uninhabited.
 */
export function isKnownUninhabitedSystem(systemName: string): boolean {
  return knownUninhabitedSystems.has(systemName.toLowerCase());
}

/**
 * Removes a system from the uninhabited cache (e.g. if a Colonisation Vessel docks there).
 */
export function unmarkUninhabitedSystem(systemName: string): void {
  knownUninhabitedSystems.delete(systemName.toLowerCase());
}

/**
 * Enqueues a star system name for background EDSM coordinate and population resolution.
 */
export function enqueueSystemForCoordResolution(systemName: string): void {
  if (!env.edsmResolverEnabled) return;
  const trimmed = systemName.trim();
  if (!trimmed) return;

  const key = trimmed.toLowerCase();
  if (queuedOrResolved.has(key)) return;

  if (queuedOrResolved.size >= MAX_CACHE_SIZE) {
    const firstKey = queuedOrResolved.values().next().value;
    if (firstKey) queuedOrResolved.delete(firstKey);
  }

  queuedOrResolved.add(key);
  pendingQueue.push(trimmed);
}

async function fetchSystemFromSpansh(
  systemName: string,
): Promise<ResolvedExternalSystem | null> {
  try {
    const response = await fetch("https://spansh.co.uk/api/systems/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PPH-Trading-Computer/1.0",
      },
      body: JSON.stringify({
        filters: {
          name: { value: systemName },
        },
        size: 5,
        page: 0,
      }),
      signal: AbortSignal.timeout(6_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      results?: SpanshSystemLookupResult[];
    };
    const match = (data.results ?? []).find(
      (r) => r.name?.trim().toLowerCase() === systemName.trim().toLowerCase(),
    );
    if (!match || !match.name) return null;

    const controllingPower = Array.isArray(match.power)
      ? match.power[0] ?? null
      : (match.power ?? null);

    return {
      name: match.name,
      id64Str: match.id64 != null ? String(match.id64) : null,
      coords:
        typeof match.x === "number" &&
        typeof match.y === "number" &&
        typeof match.z === "number"
          ? { x: match.x, y: match.y, z: match.z }
          : null,
      population: match.population ?? 0,
      isBeingColonised: Boolean(match.is_being_colonised),
      allegiance: cleanFdevToken(match.allegiance),
      government: cleanFdevToken(match.government),
      economy: cleanFdevToken(match.primary_economy),
      security: cleanFdevToken(match.security),
      controllingFaction: match.controlling_minor_faction ?? null,
      controllingPower,
      powerplayState: match.power_state ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchSystemFromEdsm(
  systemName: string,
): Promise<ResolvedExternalSystem | null> {
  try {
    const url = new URL("https://www.edsm.net/api-v1/system");
    url.searchParams.set("systemName", systemName);
    url.searchParams.set("showCoordinates", "1");
    url.searchParams.set("showId", "1");
    url.searchParams.set("showInformation", "1");

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(6_000),
      headers: {
        "User-Agent": "PPH-Trading-Computer/1.0",
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as EdsmSystemResponse | unknown[];
    if (!data || Array.isArray(data) || typeof data !== "object" || !("name" in data)) {
      return null;
    }

    const edsm = data as EdsmSystemResponse;
    if (!edsm.name) return null;
    const info = edsm.information;

    return {
      name: edsm.name,
      id64Str: edsm.id64 != null ? String(edsm.id64) : null,
      coords: edsm.coords ?? null,
      population: info?.population ?? 0,
      isBeingColonised: false,
      allegiance: cleanFdevToken(info?.allegiance),
      government: cleanFdevToken(info?.government),
      economy: cleanFdevToken(info?.economy),
      security: cleanFdevToken(info?.security),
      controllingFaction: info?.faction ?? null,
      controllingPower: null,
      powerplayState: null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a single system against Spansh first (falling back to EDSM `/api-v1/system`)
 * and updates PostgreSQL.
 */
export async function resolveSystemFromEdsm(systemName: string): Promise<boolean> {
  const resolved =
    (await fetchSystemFromSpansh(systemName)) ?? (await fetchSystemFromEdsm(systemName));

  if (!resolved) {
    return false;
  }

  const { coords, id64Str, population, isBeingColonised } = resolved;

  if (population <= 0 && !isBeingColonised) {
    // System has no recorded population in Spansh/EDSM.
    // Check if it has an active colonisation vessel or a permanent non-carrier station.
    const statusRows = await sql<{
      id: number;
      is_under_colonisation: boolean;
      has_permanent_or_colonisation_station: boolean;
    }[]>`
      SELECT
        sys.id::int AS id,
        sys.is_under_colonisation,
        EXISTS (
          SELECT 1 FROM stations st
          WHERE st.system_id = sys.id
            AND (st.is_colonisation_vessel = true OR st.is_fleet_carrier = false)
        ) AS has_permanent_or_colonisation_station
      FROM systems sys
      WHERE LOWER(sys.name) = LOWER(${systemName})
      LIMIT 1
    `;

    const sysRow = statusRows[0];
    if (!sysRow) {
      return false;
    }

    if (!sysRow.is_under_colonisation && !sysRow.has_permanent_or_colonisation_station) {
      // Strictly uninhabited system with only a transient Fleet Carrier (or no stations): purge it!
      await sql`DELETE FROM systems WHERE id = ${sysRow.id}`;
      if (knownUninhabitedSystems.size >= MAX_CACHE_SIZE) {
        const oldest = knownUninhabitedSystems.values().next().value;
        if (oldest) knownUninhabitedSystems.delete(oldest);
      }
      knownUninhabitedSystems.add(systemName.toLowerCase());
      return true;
    }

    // System is under active colonisation (or has a permanent station in a newly colonised system):
    // backfill its 3D coordinates!
    if (coords) {
      await sql`
        UPDATE systems
        SET
          system_address = COALESCE(system_address, ${id64Str}),
          x = COALESCE(x, ${coords.x}),
          y = COALESCE(y, ${coords.y}),
          z = COALESCE(z, ${coords.z})
        WHERE id = ${sysRow.id}
      `;
    }
    return true;
  }

  // System is inhabited (or being colonised): insert or backfill coordinates, population, and metadata
  const effectivePop = population > 0 ? String(population) : null;
  const existingRows = await sql<{ id: number }[]>`
    SELECT id::int AS id
    FROM systems
    WHERE LOWER(name) = LOWER(${systemName})
    LIMIT 1
  `;

  if (existingRows[0]) {
    await sql`
      UPDATE systems
      SET
        system_address = COALESCE(system_address, ${id64Str}),
        x = COALESCE(x, ${coords?.x ?? null}),
        y = COALESCE(y, ${coords?.y ?? null}),
        z = COALESCE(z, ${coords?.z ?? null}),
        population = CASE
          WHEN ${effectivePop}::bigint IS NOT NULL AND COALESCE(population, 0) <= 1 THEN ${effectivePop}::bigint
          ELSE population
        END,
        is_under_colonisation = is_under_colonisation OR ${isBeingColonised},
        allegiance = COALESCE(allegiance, ${resolved.allegiance}),
        government = COALESCE(government, ${resolved.government}),
        primary_economy = COALESCE(primary_economy, ${resolved.economy}),
        security = COALESCE(security, ${resolved.security}),
        controlling_faction = COALESCE(controlling_faction, ${resolved.controllingFaction}),
        controlling_power = COALESCE(controlling_power, ${resolved.controllingPower}),
        powerplay_state = COALESCE(powerplay_state, ${resolved.powerplayState})
      WHERE id = ${existingRows[0].id}
    `;
  } else {
    await sql`
      INSERT INTO systems (
        name, system_address, x, y, z, population, is_under_colonisation,
        allegiance, government, primary_economy, security,
        controlling_faction, controlling_power, powerplay_state
      )
      VALUES (
        ${resolved.name},
        ${id64Str},
        ${coords?.x ?? null},
        ${coords?.y ?? null},
        ${coords?.z ?? null},
        ${effectivePop}::bigint,
        ${isBeingColonised},
        ${resolved.allegiance},
        ${resolved.government},
        ${resolved.economy},
        ${resolved.security},
        ${resolved.controllingFaction},
        ${resolved.controllingPower},
        ${resolved.powerplayState}
      )
      ON CONFLICT (name) DO UPDATE SET
        system_address = COALESCE(systems.system_address, EXCLUDED.system_address),
        x = COALESCE(systems.x, EXCLUDED.x),
        y = COALESCE(systems.y, EXCLUDED.y),
        z = COALESCE(systems.z, EXCLUDED.z),
        population = COALESCE(systems.population, EXCLUDED.population),
        is_under_colonisation = systems.is_under_colonisation OR EXCLUDED.is_under_colonisation
    `;
  }

  return true;
}

async function processNextInQueue(): Promise<void> {
  if (isProcessing || pendingQueue.length === 0) return;
  isProcessing = true;

  const systemName = pendingQueue.shift();
  try {
    if (systemName) {
      await resolveSystemFromEdsm(systemName);
    }
  } catch (err) {
    console.warn(
      `[CoordResolver] Failed to resolve "${systemName}" from EDSM: ${(err as Error).message}`,
    );
  } finally {
    isProcessing = false;
  }
}

/**
 * Starts the background rate-limited EDSM coordinate & population resolver loop.
 */
export function startCoordResolver(): void {
  if (!env.edsmResolverEnabled || workerTimer) return;
  workerTimer = setInterval(() => {
    void processNextInQueue();
  }, env.edsmRateLimitMs);
}

/**
 * Stops the background EDSM coordinate resolver loop.
 */
export function stopCoordResolver(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
