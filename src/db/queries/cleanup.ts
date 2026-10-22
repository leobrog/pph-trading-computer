import { env } from "../../config/env.ts";
import { sql } from "../index.ts";

export interface TtlCleanupResult {
  expiredCarrierListings: number;
  expiredStationListings: number;
  expiredTransientStations: number;
  purgedUninhabitedSystems: number;
  expiredSystemFactions: number;
  durationMs: number;
}

/**
 * Executes the tiered Time-To-Live (TTL) database cleanup queries.
 */
export async function runTtlCleanup(options?: {
  carrierMarketHours?: number;
  stationMarketHours?: number;
  transientStationDays?: number;
  factionStateDays?: number;
}): Promise<TtlCleanupResult> {
  const start = performance.now();

  const carrierHours = options?.carrierMarketHours ?? env.ttl.carrierMarketHours;
  const stationHours = options?.stationMarketHours ?? env.ttl.stationMarketHours;
  const transientDays = options?.transientStationDays ?? env.ttl.transientStationDays;
  const factionDays = options?.factionStateDays ?? env.ttl.factionStateDays;

  // 1. Expire stale Fleet Carrier market listings (default: 48 hours)
  const carrierListingRows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM market_listings ml
      USING stations s
      WHERE ml.market_id = s.market_id
        AND s.is_fleet_carrier = true
        AND ml.updated_at < NOW() - (${carrierHours}::int * INTERVAL '1 hour')
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  // 2. Expire stale Station & Colonisation Vessel market listings (default: 168 hours / 7 days)
  const stationListingRows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM market_listings
      WHERE updated_at < NOW() - (${stationHours}::int * INTERVAL '1 hour')
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  // 3. Expire inactive Fleet Carriers & finished/inactive Colonisation Vessels (default: 14 days)
  const transientStationRows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM stations
      WHERE (is_fleet_carrier = true OR is_colonisation_vessel = true)
        AND updated_at < NOW() - (${transientDays}::int * INTERVAL '1 day')
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  // Clear `is_under_colonisation` flag on systems that no longer have an active Colonisation Vessel
  await sql`
    UPDATE systems sys
    SET is_under_colonisation = false
    WHERE sys.is_under_colonisation = true
      AND NOT EXISTS (
        SELECT 1 FROM stations st
        WHERE st.system_id = sys.id
          AND st.is_colonisation_vessel = true
      )
  `;

  // 4. Purge uninhabited systems (population = 0 or NULL) that do not have an active Colonisation Vessel
  const uninhabitedSystemRows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM systems sys
      WHERE COALESCE(sys.population, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM stations st
          WHERE st.system_id = sys.id
            AND st.is_colonisation_vessel = true
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  // 5. Expire stale system_factions BGS snapshots (default: 14 days)
  const factionStateRows = await sql<{ count: number }[]>`
    WITH deleted AS (
      DELETE FROM system_factions
      WHERE updated_at < NOW() - (${factionDays}::int * INTERVAL '1 day')
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  const durationMs = Math.round(performance.now() - start);

  return {
    expiredCarrierListings: carrierListingRows[0]?.count ?? 0,
    expiredStationListings: stationListingRows[0]?.count ?? 0,
    expiredTransientStations: transientStationRows[0]?.count ?? 0,
    purgedUninhabitedSystems: uninhabitedSystemRows[0]?.count ?? 0,
    expiredSystemFactions: factionStateRows[0]?.count ?? 0,
    durationMs,
  };
}
