import { describe, expect, test } from "bun:test";
import {
  cleanFdevToken,
  cleanStationName,
  inferMaxLandingPad,
  isColonisationVessel,
  isFleetCarrier,
  normalizeBracket,
} from "../src/listener/normalizer.ts";
import { isFreshTimestamp, isLiveGalaxyMessage } from "../src/listener/router.ts";

describe("FDev String, Colonisation & Pad Size Normalizer", () => {
  test("cleans FDev localization tokens into human-readable labels", () => {
    expect(cleanFdevToken("$economy_Agri;")).toBe("Agriculture");
    expect(cleanFdevToken("$economy_HighTech;")).toBe("High Tech");
    expect(cleanFdevToken("$government_Communism;")).toBe("Communism");
    expect(cleanFdevToken("$government_Megaconstruction;")).toBe("Megaconstruction");
    expect(cleanFdevToken("$SYSTEM_SECURITY_high;")).toBe("High");
    expect(cleanFdevToken("$GAlAXY_MAP_INFO_state_anarchy;")).toBe("Anarchy");
    expect(cleanFdevToken("$Faction_HappinessBand1;")).toBe("Elated");
    expect(cleanFdevToken("Independent")).toBe("Independent");
    expect(cleanFdevToken(null)).toBeNull();
  });

  test("cleans station names including Trailblazers Colonisation Ships", () => {
    expect(cleanStationName("$EXT_PANEL_ColonisationShip; Shin Enterprise")).toBe(
      "Colonisation Ship: Shin Enterprise",
    );
    expect(cleanStationName("$EXT_PANEL_ColonisationShip:#index=1;")).toBe(
      "System Colonisation Ship #1",
    );
    expect(cleanStationName("Woodroffe Gateway")).toBe("Woodroffe Gateway");
  });

  test("detects active Colonisation Vessels accurately", () => {
    expect(
      isColonisationVessel({ stationName: "$EXT_PANEL_ColonisationShip; Shin Enterprise" }),
    ).toBe(true);
    expect(
      isColonisationVessel({ stationName: "Orbital Construction Site: Bellman Hub" }),
    ).toBe(true);
    expect(
      isColonisationVessel({
        stationName: "Some Vessel",
        government: "$government_Megaconstruction;",
      }),
    ).toBe(true);
    expect(
      isColonisationVessel({
        stationName: "Some Vessel",
        services: ["dock", "colonisationcontribution", "commodities"],
      }),
    ).toBe(true);
    expect(
      isColonisationVessel({
        stationName: "Woodroffe Gateway",
        stationType: "Coriolis",
        government: "$government_Communism;",
      }),
    ).toBe(false);
  });

  test("detects Fleet Carriers by stationType or callsign", () => {
    expect(isFleetCarrier("FleetCarrier", "Q9X-12B")).toBe(true);
    expect(isFleetCarrier(null, "V6T-89K")).toBe(true);
    expect(isFleetCarrier("Coriolis", "Woodroffe Gateway")).toBe(false);
  });

  test("infers maximum landing pad size from LandingPads or StationType", () => {
    expect(inferMaxLandingPad({ Small: 4, Medium: 8, Large: 12 }, "Outpost")).toBe("L");
    expect(inferMaxLandingPad({ Small: 4, Medium: 2, Large: 0 }, "Outpost")).toBe("M");
    expect(inferMaxLandingPad({ Small: 2, Medium: 0, Large: 0 }, "OnFootSettlement")).toBe("S");
    expect(inferMaxLandingPad(null, "Coriolis")).toBe("L");
    expect(inferMaxLandingPad(null, "Outpost")).toBe("M");
    expect(inferMaxLandingPad(null, "OnFootSettlement")).toBeNull();
    expect(inferMaxLandingPad(null, null, true)).toBe("L");
  });

  test("normalizes stock and demand brackets", () => {
    expect(normalizeBracket(3)).toBe(3);
    expect(normalizeBracket("2")).toBe(2);
    expect(normalizeBracket("")).toBeNull();
    expect(normalizeBracket(null)).toBeNull();
  });
});

describe("EDDN Router Filters (Legacy Galaxy & Timestamp Hygiene)", () => {
  test("filters out Legacy 3.8 clients and allows Live 4.0+ clients", () => {
    expect(
      isLiveGalaxyMessage({
        $schemaRef: "https://eddn.edcd.io/schemas/commodity/3",
        header: { gameversion: "4.4.2.0" },
        message: {},
      }),
    ).toBe(true);

    expect(
      isLiveGalaxyMessage({
        $schemaRef: "https://eddn.edcd.io/schemas/commodity/3",
        header: { gameversion: "3.8.0.404" },
        message: {},
      }),
    ).toBe(false);

    expect(
      isLiveGalaxyMessage({
        $schemaRef: "https://eddn.edcd.io/schemas/commodity/3",
        header: { gameversion: "CAPI-Legacy-market" },
        message: {},
      }),
    ).toBe(false);

    expect(
      isLiveGalaxyMessage({
        $schemaRef: "https://eddn.edcd.io/schemas/commodity/3",
        header: { gameversion: "CAPI-live-market" },
        message: {},
      }),
    ).toBe(true);
  });

  test("rejects stale historical log replays and future clock skew", () => {
    const gatewayNow = "2026-10-22T16:00:00Z";
    const freshMsg = "2026-10-22T15:58:00Z";
    const staleReplay = "2025-05-01T12:00:00Z";
    const farFuture = "2026-10-22T18:00:00Z";

    expect(isFreshTimestamp(freshMsg, gatewayNow, 168)).toBe(true);
    expect(isFreshTimestamp(staleReplay, gatewayNow, 168)).toBe(false);
    expect(isFreshTimestamp(farFuture, gatewayNow, 168)).toBe(false);
  });
});
