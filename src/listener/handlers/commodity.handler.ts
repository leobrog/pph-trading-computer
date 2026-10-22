import { normalizeCommoditySymbol } from "../../../scripts/seed-commodities.ts";
import { env } from "../../config/env.ts";
import {
  getSystemByName,
  type MarketCommodityItem,
  resolveCommodityId,
  upsertStationMarket,
  upsertSystem,
} from "../../db/queries/ingest.ts";
import {
  enqueueSystemForCoordResolution,
  isKnownUninhabitedSystem,
  unmarkUninhabitedSystem,
} from "../coord-resolver.ts";
import {
  cleanFdevToken,
  cleanStationName,
  inferMaxLandingPad,
  isColonisationVessel,
  isFleetCarrier,
  normalizeBracket,
} from "../normalizer.ts";

export interface EddnCommodityEntry {
  name: string;
  meanPrice: number;
  buyPrice: number;
  stock: number;
  stockBracket?: number | string | null;
  sellPrice: number;
  demand: number;
  demandBracket?: number | string | null;
  statusFlags?: string[];
}

export interface EddnCommodityMessage {
  systemName: string;
  stationName: string;
  stationType?: string;
  marketId: number;
  timestamp: string;
  commodities: EddnCommodityEntry[];
  carrierDockingAccess?: string;
  economies?: Array<{ name: string; proportion: number }>;
  prohibited?: string[];
  odyssey?: boolean;
  horizons?: boolean;
}

export interface CommodityHandleResult {
  handled: boolean;
  reason?: string;
  listingsCount?: number;
}

/**
 * Processes an EDDN `commodity/3` market snapshot message.
 */
export async function handleCommodityMessage(
  message: EddnCommodityMessage,
): Promise<CommodityHandleResult> {
  const systemName = message.systemName?.trim();
  const rawStationName = message.stationName?.trim();
  const marketId = message.marketId;

  if (!systemName || !rawStationName || !marketId || !Array.isArray(message.commodities)) {
    return { handled: false, reason: "invalid_payload" };
  }

  const colonisation = isColonisationVessel({
    stationName: rawStationName,
    stationType: message.stationType,
  });
  const carrier = !colonisation && isFleetCarrier(message.stationType, rawStationName);

  let systemRecord = await getSystemByName(systemName);

  if (colonisation) {
    unmarkUninhabitedSystem(systemName);
    systemRecord = await upsertSystem({
      name: systemName,
      isUnderColonisation: true,
      updatedAt: message.timestamp,
    });
  } else if (carrier) {
    // Uninhabited System Gate for Fleet Carriers:
    // Never keep Fleet Carrier markets in uninhabited systems without an active Colonisation Vessel.
    if (isKnownUninhabitedSystem(systemName)) {
      return { handled: false, reason: "carrier_in_uninhabited_system" };
    }

    if (systemRecord) {
      const isPopulated = (systemRecord.population ?? 0) > 0;
      if (!isPopulated && !systemRecord.is_under_colonisation) {
        return { handled: false, reason: "carrier_in_uninhabited_system" };
      }
    } else {
      if (!env.edsmResolverEnabled) {
        return { handled: false, reason: "carrier_in_unknown_system" };
      }
      // Create provisional system record (population = null) to be verified by EDSM resolver
      systemRecord = await upsertSystem({
        name: systemName,
        population: null,
        isUnderColonisation: false,
        updatedAt: message.timestamp,
      });
    }
  } else {
    // Permanent station (Coriolis, Orbis, Outpost, Surface Port, Settlement):
    // Permanent stations only exist in inhabited or newly colonised systems.
    systemRecord = await upsertSystem({
      name: systemName,
      population: systemRecord?.population && systemRecord.population > 1 ? systemRecord.population : 1,
      updatedAt: message.timestamp,
    });
  }

  const cleanedName = cleanStationName(rawStationName);
  const effectiveStationType = message.stationType ?? (carrier ? "FleetCarrier" : null);
  const maxLandingPad = inferMaxLandingPad(null, effectiveStationType, colonisation);

  const items: MarketCommodityItem[] = [];
  for (const entry of message.commodities) {
    if (!entry.name) continue;
    const commodityId = await resolveCommodityId(entry.name);
    items.push({
      commodityId,
      meanPrice: Math.max(0, Math.trunc(entry.meanPrice || 0)),
      buyPrice: Math.max(0, Math.trunc(entry.buyPrice || 0)),
      stock: Math.max(0, Math.trunc(entry.stock || 0)),
      stockBracket: normalizeBracket(entry.stockBracket),
      sellPrice: Math.max(0, Math.trunc(entry.sellPrice || 0)),
      demand: Math.max(0, Math.trunc(entry.demand || 0)),
      demandBracket: normalizeBracket(entry.demandBracket),
      statusFlags: Array.isArray(entry.statusFlags) ? entry.statusFlags : null,
    });
  }

  const cleanedEconomies = Array.isArray(message.economies)
    ? message.economies.map((e) => ({
        name: cleanFdevToken(e.name) ?? e.name,
        proportion: e.proportion,
      }))
    : null;

  const cleanedProhibited = Array.isArray(message.prohibited)
    ? message.prohibited.map((p) => normalizeCommoditySymbol(p)).filter(Boolean)
    : null;

  const result = await upsertStationMarket({
    marketId,
    systemId: systemRecord.id,
    stationName: cleanedName,
    stationType: effectiveStationType,
    isFleetCarrier: carrier,
    isColonisationVessel: colonisation,
    maxLandingPad,
    carrierDockingAccess: message.carrierDockingAccess ?? null,
    economies: cleanedEconomies,
    prohibitedCommodities: cleanedProhibited,
    marketUpdatedAt: message.timestamp,
    items,
  });

  if (
    systemRecord.x === null ||
    systemRecord.y === null ||
    systemRecord.z === null ||
    (systemRecord.population ?? 0) <= 1
  ) {
    enqueueSystemForCoordResolution(systemName);
  }

  if (!result.updated) {
    return { handled: false, reason: "stale_market_snapshot" };
  }

  return { handled: true, listingsCount: result.listingsCount };
}
