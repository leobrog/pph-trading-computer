import { env } from "../config/env.ts";
import {
  type EddnCommodityMessage,
  handleCommodityMessage,
} from "./handlers/commodity.handler.ts";
import { type EddnJournalMessage, handleJournalMessage } from "./handlers/journal.handler.ts";
import type { EddnEnvelope } from "./zmtp-client.ts";

export const SCHEMA_COMMODITY_V3 = "https://eddn.edcd.io/schemas/commodity/3";
export const SCHEMA_JOURNAL_V1 = "https://eddn.edcd.io/schemas/journal/1";

const SUPPORTED_JOURNAL_EVENTS = new Set(["Docked", "FSDJump", "Location", "CarrierJump"]);

const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000; // 10 minutes

export interface ListenerStats {
  startedAt: number;
  totalReceived: number;
  legacyFiltered: number;
  staleFiltered: number;
  ignoredSchemasOrEvents: number;
  commodityProcessed: number;
  journalDockedProcessed: number;
  journalFsdJumpProcessed: number;
  journalLocationProcessed: number;
  journalCarrierJumpProcessed: number;
  errors: number;
}

export const listenerStats: ListenerStats = {
  startedAt: Date.now(),
  totalReceived: 0,
  legacyFiltered: 0,
  staleFiltered: 0,
  ignoredSchemasOrEvents: 0,
  commodityProcessed: 0,
  journalDockedProcessed: 0,
  journalFsdJumpProcessed: 0,
  journalLocationProcessed: 0,
  journalCarrierJumpProcessed: 0,
  errors: 0,
};

/**
 * Checks whether an EDDN envelope comes from the Live 4.0+ galaxy (Horizons/Odyssey)
 * rather than a Legacy 3.8 client.
 */
export function isLiveGalaxyMessage(envelope: EddnEnvelope): boolean {
  const rawVersion = envelope.header?.gameversion?.trim();
  const msg = envelope.message ?? {};

  if (rawVersion) {
    const lower = rawVersion.toLowerCase();
    if (lower.includes("legacy")) {
      return false;
    }
    if (lower.startsWith("capi")) {
      return !lower.includes("legacy");
    }
    const majorMatch = rawVersion.match(/^(\d+)\./);
    if (majorMatch?.[1]) {
      const major = Number.parseInt(majorMatch[1], 10);
      return major >= 4;
    }
  }

  // If gameversion header is missing, require explicit odyssey=true flag on message
  if (msg.odyssey === true) {
    return true;
  }

  return false;
}

/**
 * Validates that `message.timestamp` is a valid ISO timestamp, is not a historical
 * log replay older than our configured TTL window, and is not skewed >10m into the future.
 */
export function isFreshTimestamp(
  messageTimestamp: unknown,
  gatewayTimestamp?: unknown,
  maxAgeHours: number = env.ttl.stationMarketHours,
): boolean {
  if (typeof messageTimestamp !== "string" || !messageTimestamp) {
    return false;
  }

  const msgMs = Date.parse(messageTimestamp);
  if (Number.isNaN(msgMs)) {
    return false;
  }

  const refMs =
    typeof gatewayTimestamp === "string" && !Number.isNaN(Date.parse(gatewayTimestamp))
      ? Date.parse(gatewayTimestamp)
      : Date.now();

  if (msgMs > refMs + MAX_FUTURE_SKEW_MS) {
    return false;
  }

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  if (msgMs < refMs - maxAgeMs) {
    return false;
  }

  return true;
}

/**
 * Filters and routes an incoming EDDN message envelope to the appropriate handler.
 */
export async function routeEddnEnvelope(envelope: EddnEnvelope): Promise<void> {
  listenerStats.totalReceived++;

  const schemaRef = envelope.$schemaRef;
  if (schemaRef !== SCHEMA_COMMODITY_V3 && schemaRef !== SCHEMA_JOURNAL_V1) {
    listenerStats.ignoredSchemasOrEvents++;
    return;
  }

  // Fast filter for high-volume exploration journal events (Scan, SAASignalsFound, etc.)
  if (schemaRef === SCHEMA_JOURNAL_V1) {
    const eventName =
      typeof envelope.message?.event === "string" ? envelope.message.event : "";
    if (!SUPPORTED_JOURNAL_EVENTS.has(eventName)) {
      listenerStats.ignoredSchemasOrEvents++;
      return;
    }
  }

  // 1. Legacy 3.8 Galaxy Filter
  if (!isLiveGalaxyMessage(envelope)) {
    listenerStats.legacyFiltered++;
    return;
  }

  // 2. Timestamp Sanity & Freshness Gate
  if (!isFreshTimestamp(envelope.message?.timestamp, envelope.header?.gatewayTimestamp)) {
    listenerStats.staleFiltered++;
    return;
  }

  // 3. Dispatch to schema handler
  try {
    if (schemaRef === SCHEMA_COMMODITY_V3) {
      const res = await handleCommodityMessage(
        envelope.message as unknown as EddnCommodityMessage,
      );
      if (res.handled) {
        listenerStats.commodityProcessed++;
      }
      return;
    }

    if (schemaRef === SCHEMA_JOURNAL_V1) {
      const res = await handleJournalMessage(
        envelope.message as unknown as EddnJournalMessage,
      );
      if (res.handled) {
        switch (res.event) {
          case "Docked":
            listenerStats.journalDockedProcessed++;
            break;
          case "FSDJump":
            listenerStats.journalFsdJumpProcessed++;
            break;
          case "Location":
            listenerStats.journalLocationProcessed++;
            break;
          case "CarrierJump":
            listenerStats.journalCarrierJumpProcessed++;
            break;
        }
      }
    }
  } catch (err) {
    listenerStats.errors++;
    console.error(`[Router] Error handling ${schemaRef}:`, err);
  }
}
