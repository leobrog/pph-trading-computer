import { env } from "../config/env.ts";
import { sql } from "../db/index.ts";

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

/**
 * Resolves a single system against EDSM `/api-v1/system` and updates PostgreSQL.
 */
export async function resolveSystemFromEdsm(systemName: string): Promise<boolean> {
  const url = new URL("https://www.edsm.net/api-v1/system");
  url.searchParams.set("systemName", systemName);
  url.searchParams.set("showCoordinates", "1");
  url.searchParams.set("showId", "1");
  url.searchParams.set("showInformation", "1");

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8_000),
    headers: {
      "User-Agent": "PPH-Trading-Computer/1.0",
    },
  });

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as EdsmSystemResponse | unknown[];
  if (!data || Array.isArray(data) || typeof data !== "object" || !("name" in data)) {
    return false;
  }

  const edsm = data as EdsmSystemResponse;
  const coords = edsm.coords;
  const info = edsm.information;
  const edsmPopulation = info?.population ?? 0;
  const id64Str = edsm.id64 != null ? String(edsm.id64) : null;

  if (edsmPopulation <= 0) {
    // System has no recorded population in EDSM.
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

  // System is inhabited (edsmPopulation > 0): backfill coordinates, population, and metadata
  await sql`
    UPDATE systems
    SET
      system_address = COALESCE(system_address, ${id64Str}),
      x = COALESCE(x, ${coords?.x ?? null}),
      y = COALESCE(y, ${coords?.y ?? null}),
      z = COALESCE(z, ${coords?.z ?? null}),
      population = CASE
        WHEN COALESCE(population, 0) <= 1 THEN ${String(edsmPopulation)}::bigint
        ELSE population
      END,
      allegiance = COALESCE(allegiance, ${info?.allegiance ?? null}),
      government = COALESCE(government, ${info?.government ?? null}),
      primary_economy = COALESCE(primary_economy, ${info?.economy ?? null}),
      security = COALESCE(security, ${info?.security ?? null}),
      controlling_faction = COALESCE(controlling_faction, ${info?.faction ?? null})
    WHERE LOWER(name) = LOWER(${systemName})
  `;

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
