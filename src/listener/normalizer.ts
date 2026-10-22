export type LandingPadSize = "S" | "M" | "L" | null;

export interface RawLandingPads {
  Small?: number;
  Medium?: number;
  Large?: number;
}

const KNOWN_TOKEN_MAP: Record<string, string> = {
  // Economies
  agri: "Agriculture",
  agriculture: "Agriculture",
  colony: "Colony",
  extraction: "Extraction",
  hightech: "High Tech",
  industrial: "Industrial",
  military: "Military",
  none: "None",
  prison: "Prison",
  privateenterprise: "Private Enterprise",
  carrier: "Fleet Carrier",
  refinery: "Refinery",
  repair: "Repair",
  rescue: "Rescue",
  service: "Service",
  terraforming: "Terraforming",
  tourism: "Tourism",
  contraband: "Contraband",
  damaged: "Damaged",
  engineer: "Engineering",
  undefined: "None",

  // Governments
  anarchy: "Anarchy",
  communism: "Communism",
  confederacy: "Confederacy",
  cooperative: "Cooperative",
  corporate: "Corporate",
  democracy: "Democracy",
  dictatorship: "Dictatorship",
  feudal: "Feudal",
  imperial: "Imperial",
  patronage: "Patronage",
  prisoncolony: "Prison Colony",
  theocracy: "Theocracy",
  workshop: "Engineer Workshop",
  megaconstruction: "Megaconstruction",

  // Security levels
  high: "High",
  medium: "Medium",
  low: "Low",
  high_anarchy: "Anarchy",

  // Happiness levels
   happinessband1: "Elated",
  happinessband2: "Happy",
  happinessband3: "Discontented",
  happinessband4: "Unhappy",
  happinessband5: "Despondent",
};

/**
 * Cleans Frontier localization tokens such as:
 * - "$economy_Agri;" -> "Agriculture"
 * - "$government_Communism;" -> "Communism"
 * - "$SYSTEM_SECURITY_high;" -> "High"
 * - "$GAlAXY_MAP_INFO_state_anarchy;" -> "Anarchy"
 * - "$Faction_HappinessBand1;" -> "Elated"
 */
export function cleanFdevToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("$") && !trimmed.endsWith(";")) {
    return trimmed;
  }

  const stripped = trimmed
    .replace(/^\$/, "")
    .replace(/;$/, "")
    .replace(/_name$/i, "")
    .replace(
      /^(?:economy|government|system_security|galaxy_map_info_state|allegiance|faction|factionstate)_/i,
      "",
    );

  const lookupKey = stripped.toLowerCase();
  if (KNOWN_TOKEN_MAP[lookupKey]) {
    return KNOWN_TOKEN_MAP[lookupKey]!;
  }

  // Fallback: split camelCase or underscores into Title Case words
  return stripped
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

/**
 * Cleans station names, including Trailblazers Colonisation Ship localization prefixes:
 * - "$EXT_PANEL_ColonisationShip; Shin Enterprise" -> "Colonisation Ship: Shin Enterprise"
 * - "$EXT_PANEL_ColonisationShip:#index=1;" -> "System Colonisation Ship #1"
 */
export function cleanStationName(raw: string | null | undefined): string {
  if (!raw) return "Unknown Station";
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown Station";

  // Match "$EXT_PANEL_ColonisationShip:#index=1;" or "$EXT_PANEL_ColonisationShip; Name"
  if (/^\$EXT_PANEL_ColonisationShip/i.test(trimmed)) {
    const indexMatch = trimmed.match(/#index=(\d+)/i);
    const afterSemicolon = trimmed.split(";").slice(1).join(";").trim();
    if (afterSemicolon) {
      return `Colonisation Ship: ${afterSemicolon}`;
    }
    if (indexMatch?.[1]) {
      return `System Colonisation Ship #${indexMatch[1]}`;
    }
    return "System Colonisation Ship";
  }

  return trimmed;
}

export interface ColonisationCheckInput {
  stationName?: string | null;
  stationType?: string | null;
  government?: string | null;
  services?: string[] | null;
}

/**
 * Determines whether a station represents an active System Colonisation Vessel
 * or Orbital/Planetary Construction Site.
 */
export function isColonisationVessel(input: ColonisationCheckInput): boolean {
  const rawName = (input.stationName ?? "").trim();
  if (
    /^\$EXT_PANEL_ColonisationShip/i.test(rawName) ||
    /^System Colonisation Ship/i.test(rawName) ||
    /^Colonisation Ship:/i.test(rawName) ||
    /^Orbital Construction Site/i.test(rawName) ||
    /^Planetary Construction Site/i.test(rawName)
  ) {
    return true;
  }

  const rawGov = (input.government ?? "").trim().toLowerCase();
  if (rawGov === "$government_megaconstruction;" || rawGov === "megaconstruction") {
    return true;
  }

  if (Array.isArray(input.services)) {
    for (const svc of input.services) {
      if (svc.toLowerCase() === "colonisationcontribution") {
        return true;
      }
    }
  }

  return false;
}

const FLEET_CARRIER_CALLSIGN_REGEX = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/i;

/**
 * Determines whether a station is a player-owned Fleet Carrier (or Stronghold Carrier).
 */
export function isFleetCarrier(
  stationType?: string | null,
  stationName?: string | null,
): boolean {
  if (stationType) {
    const normalizedType = stationType.trim().toLowerCase();
    if (normalizedType === "fleetcarrier") {
      return true;
    }
  }
  if (stationName && FLEET_CARRIER_CALLSIGN_REGEX.test(stationName.trim())) {
    return true;
  }
  return false;
}

const LARGE_PAD_STATION_TYPES = new Set([
  "coriolis",
  "coriolisstarport",
  "orbis",
  "ocellus",
  "bernal",
  "asteroidbase",
  "craterport",
  "crateroutpost",
  "surfacestation",
  "megaship",
  "fleetcarrier",
]);

const MEDIUM_PAD_STATION_TYPES = new Set([
  "outpost",
  "civilianoutpost",
  "commercialoutpost",
  "industrialoutpost",
  "militaryoutpost",
  "miningoutpost",
  "scientificoutpost",
  "unsanctionedoutpost",
]);

/**
 * Infers the maximum landing pad size ('L', 'M', 'S', or null) from either an explicit
 * `LandingPads` object (`Docked` event) or `stationType` fallback (`commodity/3`).
 */
export function inferMaxLandingPad(
  landingPads?: RawLandingPads | null,
  stationType?: string | null,
  colonisationVessel?: boolean,
): LandingPadSize {
  if (landingPads) {
    if ((landingPads.Large ?? 0) > 0) return "L";
    if ((landingPads.Medium ?? 0) > 0) return "M";
    if ((landingPads.Small ?? 0) > 0) return "S";
  }

  if (colonisationVessel) {
    return "L";
  }

  if (stationType) {
    const normalized = stationType.trim().toLowerCase();
    if (LARGE_PAD_STATION_TYPES.has(normalized)) {
      return "L";
    }
    if (MEDIUM_PAD_STATION_TYPES.has(normalized)) {
      return "M";
    }
  }

  return null;
}

/**
 * Normalizes a bracket field from EDDN (`0 | 1 | 2 | 3 | ""` or undefined) into `number | null`.
 */
export function normalizeBracket(raw: number | string | null | undefined): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 3) {
      return parsed;
    }
  }
  return null;
}
