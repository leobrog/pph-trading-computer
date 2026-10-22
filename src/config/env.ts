function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

const postgresUser = process.env.POSTGRES_USER || "pph";
const postgresPassword = process.env.POSTGRES_PASSWORD || "pph_secret";
const postgresDb = process.env.POSTGRES_DB || "pph_trading";
const postgresHost = process.env.POSTGRES_HOST || "db";
const postgresPort = parseIntEnv("POSTGRES_PORT", 5432);

export const env = {
  // Database
  databaseUrl:
    process.env.DATABASE_URL ||
    `postgres://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/${postgresDb}`,

  // EDDN ZeroMQ Relay
  eddnZmqUrl: process.env.EDDN_ZMQ_URL || "tcp://eddn.edcd.io:9500",
  eddnIdleTimeoutMs: parseIntEnv("EDDN_IDLE_TIMEOUT_MS", 60_000),

  // EDSM Coordinate & Population Backfill Resolver
  edsmResolverEnabled: parseBoolEnv("EDSM_RESOLVER_ENABLED", true),
  edsmRateLimitMs: parseIntEnv("EDSM_RATE_LIMIT_MS", 2_000),

  // TTL & Cleanup Configuration
  ttl: {
    cleanupIntervalMinutes: parseIntEnv("TTL_CLEANUP_INTERVAL_MINUTES", 15),
    carrierMarketHours: parseIntEnv("TTL_CARRIER_MARKET_HOURS", 48),
    stationMarketHours: parseIntEnv("TTL_STATION_MARKET_HOURS", 168),
    transientStationDays: parseIntEnv("TTL_TRANSIENT_STATION_DAYS", 14),
    factionStateDays: parseIntEnv("TTL_FACTION_STATE_DAYS", 14),
  },

  // Discord Bot
  discord: {
    token: process.env.DISCORD_TOKEN || "",
    clientId: process.env.DISCORD_CLIENT_ID || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
  },
} as const;
