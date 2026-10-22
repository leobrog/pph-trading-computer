import { sql } from "../../db/index.ts";
import {
  type FactionStateEntry,
  type NormalizedFactionInput,
  type RawJournalFaction,
  type SystemRecord,
  updateTrackedSystemCoords,
  upsertStationMeta,
  upsertSystem,
  upsertSystemFactions,
} from "../../db/queries/ingest.ts";
import { enqueueSystemForCoordResolution, unmarkUninhabitedSystem } from "../coord-resolver.ts";
import {
  cleanFdevToken,
  cleanStationName,
  inferMaxLandingPad,
  isColonisationVessel,
  isFleetCarrier,
  type RawLandingPads,
} from "../normalizer.ts";

export interface EddnJournalMessage {
  event: string;
  timestamp: string;
  StarSystem?: string;
  SystemAddress?: number;
  StarPos?: [number, number, number];
  Population?: number;
  SystemAllegiance?: string;
  SystemEconomy?: string;
  SystemGovernment?: string;
  SystemSecurity?: string;
  SystemFaction?: { Name?: string; FactionState?: string } | string;
  Factions?: RawJournalFaction[];
  ControllingPower?: string;
  PowerplayState?: string;

  // Docked / Location / CarrierJump station fields
  Docked?: boolean;
  MarketID?: number;
  StationName?: string;
  StationType?: string;
  DistFromStarLS?: number;
  LandingPads?: RawLandingPads;
  StationFaction?: { Name?: string; FactionState?: string } | string;
  StationGovernment?: string;
  StationEconomy?: string;
  StationEconomies?: Array<{ Name?: string; name?: string; Proportion?: number; proportion?: number }>;
  StationServices?: string[];
  CarrierDockingAccess?: string;

  odyssey?: boolean;
  horizons?: boolean;
}

export interface JournalHandleResult {
  handled: boolean;
  event: string;
  reason?: string;
}

function extractCoordinates(starPos?: [number, number, number]): {
  x: number | null;
  y: number | null;
  z: number | null;
} {
  if (
    Array.isArray(starPos) &&
    starPos.length === 3 &&
    typeof starPos[0] === "number" &&
    typeof starPos[1] === "number" &&
    typeof starPos[2] === "number"
  ) {
    return { x: starPos[0], y: starPos[1], z: starPos[2] };
  }
  return { x: null, y: null, z: null };
}

function extractFactionInfo(
  raw?: { Name?: string; FactionState?: string } | string | null,
): { name: string | null; state: string | null } {
  if (!raw) return { name: null, state: null };
  const rawName = typeof raw === "string" ? raw.trim() : (raw.Name?.trim() ?? "");
  if (
    !rawName ||
    rawName.toLowerCase() === "fleetcarrier" ||
    rawName.toLowerCase() === "pilots' federation local branch"
  ) {
    return { name: null, state: null };
  }
  if (typeof raw === "string") {
    return { name: rawName, state: null };
  }
  return {
    name: rawName,
    state: cleanFdevToken(raw.FactionState) ?? raw.FactionState ?? null,
  };
}

function normalizeStateArray(states?: FactionStateEntry[]): FactionStateEntry[] {
  if (!Array.isArray(states)) return [];
  return states
    .filter((s) => s && typeof s.State === "string")
    .map((s) => ({
      State: cleanFdevToken(s.State) ?? s.State,
      ...(typeof s.Trend === "number" ? { Trend: s.Trend } : {}),
    }));
}

function normalizeFactionsList(rawFactions?: RawJournalFaction[]): NormalizedFactionInput[] {
  if (!Array.isArray(rawFactions)) return [];
  const result: NormalizedFactionInput[] = [];

  for (const rf of rawFactions) {
    const name = rf.Name?.trim();
    if (!name) continue;
    result.push({
      name,
      allegiance: cleanFdevToken(rf.Allegiance),
      government: cleanFdevToken(rf.Government),
      influence: typeof rf.Influence === "number" ? rf.Influence : null,
      factionState: cleanFdevToken(rf.FactionState),
      happiness: cleanFdevToken(rf.Happiness),
      activeStates: normalizeStateArray(rf.ActiveStates),
      pendingStates: normalizeStateArray(rf.PendingStates),
      recoveringStates: normalizeStateArray(rf.RecoveringStates),
    });
  }

  return result;
}

async function processStationFromJournal(
  msg: EddnJournalMessage,
  systemRecord: SystemRecord,
  colonisation: boolean,
  carrier: boolean,
): Promise<void> {
  if (!msg.MarketID || !msg.StationName) return;

  const cleanedName = cleanStationName(msg.StationName);
  const effectiveStationType = msg.StationType ?? (carrier ? "FleetCarrier" : null);
  const maxLandingPad = inferMaxLandingPad(msg.LandingPads, effectiveStationType, colonisation);
  const stationFaction = extractFactionInfo(msg.StationFaction);

  const services = Array.isArray(msg.StationServices)
    ? msg.StationServices.map((s) => s.trim().toLowerCase())
    : null;
  const hasBlackmarket = services ? services.includes("blackmarket") : null;

  const economies = Array.isArray(msg.StationEconomies)
    ? msg.StationEconomies.map((e) => ({
        name: cleanFdevToken(e.Name ?? e.name) ?? e.Name ?? e.name ?? "Unknown",
        proportion: e.Proportion ?? e.proportion ?? 0,
      }))
    : null;

  await upsertStationMeta({
    marketId: msg.MarketID,
    systemId: systemRecord.id,
    name: cleanedName,
    stationType: effectiveStationType,
    isFleetCarrier: carrier,
    isColonisationVessel: colonisation,
    maxLandingPad,
    padSmall: msg.LandingPads?.Small ?? null,
    padMedium: msg.LandingPads?.Medium ?? null,
    padLarge: msg.LandingPads?.Large ?? null,
    distanceToArrivalLs:
      typeof msg.DistFromStarLS === "number" && msg.DistFromStarLS >= 0
        ? msg.DistFromStarLS
        : null,
    controllingFaction: stationFaction.name,
    controllingFactionState: stationFaction.state,
    government: cleanFdevToken(msg.StationGovernment),
    primaryEconomy: cleanFdevToken(msg.StationEconomy),
    economies,
    hasBlackmarket,
    services,
    carrierDockingAccess: msg.CarrierDockingAccess ?? null,
    metaUpdatedAt: msg.timestamp,
  });
}

/**
 * Processes an EDDN `journal/1` event (`Docked`, `FSDJump`, `Location`, `CarrierJump`).
 */
export async function handleJournalMessage(
  msg: EddnJournalMessage,
): Promise<JournalHandleResult> {
  const event = msg.event;
  const systemName = msg.StarSystem?.trim();

  if (!event || !systemName || !msg.timestamp) {
    return { handled: false, event: event || "Unknown", reason: "invalid_payload" };
  }

  const coords = extractCoordinates(msg.StarPos);
  const sysFaction = extractFactionInfo(msg.SystemFaction);
  const population = typeof msg.Population === "number" ? msg.Population : null;

  const colonisation = isColonisationVessel({
    stationName: msg.StationName,
    stationType: msg.StationType,
    government: msg.StationGovernment,
    services: msg.StationServices,
  });
  const carrier = !colonisation && isFleetCarrier(msg.StationType, msg.StationName);

  // --- 1. FSDJump ---
  if (event === "FSDJump") {
    if (population !== null && population > 0) {
      const sysRecord = await upsertSystem({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        population,
        allegiance: cleanFdevToken(msg.SystemAllegiance),
        government: cleanFdevToken(msg.SystemGovernment),
        primaryEconomy: cleanFdevToken(msg.SystemEconomy),
        security: cleanFdevToken(msg.SystemSecurity),
        controllingFaction: sysFaction.name,
        controllingPower: msg.ControllingPower ?? null,
        powerplayState: msg.PowerplayState ?? null,
        updatedAt: msg.timestamp,
      });

      const normalizedFactions = normalizeFactionsList(msg.Factions);
      if (normalizedFactions.length > 0) {
        await upsertSystemFactions(sysRecord.id, normalizedFactions, msg.timestamp);
      }

      return { handled: true, event };
    }

    // Uninhabited system (population === 0 or null):
    // Only update coordinates if the system is already tracked as under colonisation or populated.
    const updated = await updateTrackedSystemCoords({
      name: systemName,
      systemAddress: msg.SystemAddress ?? null,
      x: coords.x,
      y: coords.y,
      z: coords.z,
    });
    return {
      handled: updated !== null,
      event,
      reason: updated ? undefined : "uninhabited_system_ignored",
    };
  }

  // --- 2. Docked ---
  if (event === "Docked") {
    if (!msg.MarketID || !msg.StationName) {
      return { handled: false, event, reason: "missing_station_fields" };
    }

    let sysRecord: SystemRecord | null = null;

    if (colonisation) {
      unmarkUninhabitedSystem(systemName);
      sysRecord = await upsertSystem({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        population: population && population > 0 ? population : null,
        isUnderColonisation: true,
        updatedAt: msg.timestamp,
      });
    } else if (carrier) {
      // Only record Fleet Carrier dock events if the system is already known as populated or under colonisation
      sysRecord = await updateTrackedSystemCoords({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
      });
      if (!sysRecord) {
        return { handled: false, event, reason: "carrier_in_uninhabited_or_unknown_system" };
      }
    } else {
      // Permanent station dock event
      sysRecord = await upsertSystem({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        population: population && population > 0 ? population : 1,
        updatedAt: msg.timestamp,
      });
    }

    await processStationFromJournal(msg, sysRecord, colonisation, carrier);

    if (sysRecord.x === null || (sysRecord.population ?? 0) <= 1) {
      enqueueSystemForCoordResolution(systemName);
    }

    return { handled: true, event };
  }

  // --- 3. Location ---
  if (event === "Location") {
    const isDockedAtStation = Boolean(msg.Docked && msg.MarketID && msg.StationName);

    let sysRecord: SystemRecord | null = null;

    if ((population !== null && population > 0) || (isDockedAtStation && colonisation)) {
      if (colonisation) {
        unmarkUninhabitedSystem(systemName);
      }

      sysRecord = await upsertSystem({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        population: population && population > 0 ? population : null,
        isUnderColonisation: isDockedAtStation && colonisation,
        allegiance: cleanFdevToken(msg.SystemAllegiance),
        government: cleanFdevToken(msg.SystemGovernment),
        primaryEconomy: cleanFdevToken(msg.SystemEconomy),
        security: cleanFdevToken(msg.SystemSecurity),
        controllingFaction: sysFaction.name,
        controllingPower: msg.ControllingPower ?? null,
        powerplayState: msg.PowerplayState ?? null,
        updatedAt: msg.timestamp,
      });

      const normalizedFactions = normalizeFactionsList(msg.Factions);
      if (normalizedFactions.length > 0) {
        await upsertSystemFactions(sysRecord.id, normalizedFactions, msg.timestamp);
      }
    } else {
      sysRecord = await updateTrackedSystemCoords({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
      });
    }

    if (!sysRecord) {
      return { handled: false, event, reason: "uninhabited_system_ignored" };
    }

    if (isDockedAtStation) {
      await processStationFromJournal(msg, sysRecord, colonisation, carrier);
    }

    return { handled: true, event };
  }

  // --- 4. CarrierJump ---
  if (event === "CarrierJump") {
    if (!msg.MarketID || !msg.StationName) {
      return { handled: false, event, reason: "missing_carrier_fields" };
    }

    let sysRecord: SystemRecord | null = null;
    if (population !== null && population > 0) {
      sysRecord = await upsertSystem({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        population,
        allegiance: cleanFdevToken(msg.SystemAllegiance),
        government: cleanFdevToken(msg.SystemGovernment),
        primaryEconomy: cleanFdevToken(msg.SystemEconomy),
        security: cleanFdevToken(msg.SystemSecurity),
        controllingFaction: sysFaction.name,
        controllingPower: msg.ControllingPower ?? null,
        powerplayState: msg.PowerplayState ?? null,
        updatedAt: msg.timestamp,
      });
    } else {
      sysRecord = await updateTrackedSystemCoords({
        name: systemName,
        systemAddress: msg.SystemAddress ?? null,
        x: coords.x,
        y: coords.y,
        z: coords.z,
      });
    }

    if (!sysRecord) {
      // Fleet Carrier jumped into an uninhabited system without active colonisation:
      // Remove the carrier from `stations` so it doesn't stay associated with its previous inhabited system!
      await sql`
        DELETE FROM stations
        WHERE market_id = ${String(msg.MarketID)}::bigint
          AND is_fleet_carrier = true
      `;
      return { handled: true, event, reason: "carrier_jumped_to_uninhabited_system_removed" };
    }

    await processStationFromJournal(msg, sysRecord, false, true);
    return { handled: true, event };
  }

  return { handled: false, event, reason: "unsupported_journal_event" };
}
