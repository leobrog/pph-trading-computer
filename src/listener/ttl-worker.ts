import { env } from "../config/env.ts";
import { runTtlCleanup } from "../db/queries/cleanup.ts";

let cleanupTimer: Timer | null = null;
let isRunningCleanup = false;

/**
 * Executes a single TTL cleanup pass and logs the summary.
 */
export async function executeTtlCleanupPass(): Promise<void> {
  if (isRunningCleanup) return;
  isRunningCleanup = true;

  try {
    const res = await runTtlCleanup();
    const totalListings = res.expiredCarrierListings + res.expiredStationListings;

    console.log(
      `[TTL Worker] Purged ${totalListings.toLocaleString()} expired market listings ` +
        `(${res.expiredCarrierListings.toLocaleString()} carrier, ${res.expiredStationListings.toLocaleString()} station), ` +
        `${res.expiredTransientStations.toLocaleString()} stale stations, ` +
        `${res.purgedUninhabitedSystems.toLocaleString()} uninhabited systems, ` +
        `${res.expiredSystemFactions.toLocaleString()} system_factions in ${res.durationMs}ms`,
    );
  } catch (err) {
    console.error("[TTL Worker] Cleanup pass failed:", err);
  } finally {
    isRunningCleanup = false;
  }
}

/**
 * Starts the periodic TTL cleanup worker (runs immediately on startup and every `TTL_CLEANUP_INTERVAL_MINUTES`).
 */
export async function startTtlWorker(): Promise<void> {
  if (cleanupTimer) return;

  await executeTtlCleanupPass();

  const intervalMs = Math.max(1, env.ttl.cleanupIntervalMinutes) * 60 * 1000;
  cleanupTimer = setInterval(() => {
    void executeTtlCleanupPass();
  }, intervalMs);

  console.log(
    `[TTL Worker] Scheduled periodic cleanup every ${env.ttl.cleanupIntervalMinutes} minute(s) ` +
      `(Carrier Market TTL: ${env.ttl.carrierMarketHours}h, Station Market TTL: ${env.ttl.stationMarketHours}h, ` +
      `Transient Station TTL: ${env.ttl.transientStationDays}d, Faction State TTL: ${env.ttl.factionStateDays}d).`,
  );
}

/**
 * Stops the periodic TTL cleanup timer.
 */
export function stopTtlWorker(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
