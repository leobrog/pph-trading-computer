import { runMigrations } from "../../scripts/migrate.ts";
import { seedCommodities } from "../../scripts/seed-commodities.ts";
import { seedRegionAroundSystem } from "../../scripts/seed-region.ts";
import { env } from "../config/env.ts";
import { checkDatabaseConnection, closeDatabase } from "../db/index.ts";
import { getSystemByName, initCommodityCache } from "../db/queries/ingest.ts";
import { startCoordResolver, stopCoordResolver } from "./coord-resolver.ts";
import { listenerStats, routeEddnEnvelope } from "./router.ts";
import { startTtlWorker, stopTtlWorker } from "./ttl-worker.ts";
import { ZmtpSubClient } from "./zmtp-client.ts";

async function main(): Promise<void> {
  console.log("=== PPH Trading Computer — EDDN Listener Service ===");

  const dbInfo = await checkDatabaseConnection();
  console.log(`[Listener] Connected to PostgreSQL database "${dbInfo.database}"`);

  await runMigrations();
  await seedCommodities();

  const cachedCount = await initCommodityCache();
  console.log(`[Listener] Loaded ${cachedCount} commodities into symbol cache.`);

  await startTtlWorker();
  startCoordResolver();

  // Bootstrap the Heverty region in the background if Heverty is not yet in the database
  const hevertyExisting = await getSystemByName("Heverty");
  if (!hevertyExisting) {
    void seedRegionAroundSystem({ centerSystem: "Heverty", radiusLy: 40 }).catch((err) => {
      console.warn("[Listener] Initial regional seed warning:", (err as Error).message);
    });
  }

  const zmtpClient = new ZmtpSubClient({
    url: env.eddnZmqUrl,
    idleTimeoutMs: env.eddnIdleTimeoutMs,
    onMessage: routeEddnEnvelope,
    onError: (err) => {
      console.error("[Listener] Stream error:", err.message);
    },
  });

  zmtpClient.start();

  const statsTimer = setInterval(() => {
    const uptimeMin = ((Date.now() - listenerStats.startedAt) / 60_000).toFixed(1);
    console.log(
      `[Listener Stats | ${uptimeMin}m] ` +
        `recv=${listenerStats.totalReceived.toLocaleString()} | ` +
        `market=${listenerStats.commodityProcessed.toLocaleString()} | ` +
        `docked=${listenerStats.journalDockedProcessed.toLocaleString()} | ` +
        `jump=${listenerStats.journalFsdJumpProcessed.toLocaleString()} | ` +
        `loc=${listenerStats.journalLocationProcessed.toLocaleString()} | ` +
        `carrierJump=${listenerStats.journalCarrierJumpProcessed.toLocaleString()} | ` +
        `legacyDrop=${listenerStats.legacyFiltered.toLocaleString()} | ` +
        `staleDrop=${listenerStats.staleFiltered.toLocaleString()} | ` +
        `err=${listenerStats.errors}`,
    );
  }, 60_000);

  const shutdown = async (signal: string) => {
    console.log(`\n[Listener] Received ${signal}, shutting down gracefully...`);
    clearInterval(statsTimer);
    zmtpClient.stop();
    stopCoordResolver();
    stopTtlWorker();
    await closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Listener] Fatal startup error:", err);
    process.exit(1);
  });
}
