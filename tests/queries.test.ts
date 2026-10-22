import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkDatabaseConnection, sql } from "../src/db/index.ts";
import {
  initCommodityCache,
  resolveCommodityId,
  upsertStationMarket,
  upsertStationMeta,
  upsertSystem,
  upsertSystemFactions,
} from "../src/db/queries/ingest.ts";
import {
  getFactionStatusReport,
  getSystemBgsReport,
} from "../src/db/queries/bgs.ts";
import {
  findCheapestCommodityBuy,
  findFactionMarkets,
  findHighestCommoditySell,
  findInternalTradeRoutes,
  findProfitableTradeRoutes,
  findUndermineLossRoutes,
  getStationMarketListings,
} from "../src/db/queries/trading.ts";

let dbReachable = false;
try {
  await Promise.race([
    checkDatabaseConnection(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
  ]);
  dbReachable = true;
} catch {
  dbReachable = false;
}

const TEST_SYS_HEVERTY = "PPH_TEST_Heverty";
const TEST_SYS_MALGAR = "PPH_TEST_Malgar";
const TEST_SYS_NGANE = "PPH_TEST_Ngane";
const TEST_FACTION_PPH = "PPH_TEST_People's Party of Heverty";
const TEST_FACTION_RIVAL = "PPH_TEST_Malgar Syndicate";
const TEST_FACTION_NATIVE_LOW = "PPH_TEST_Heverty Jet Boys";

const TEST_MARKET_WOODROFFE = 9900000001n;
const TEST_MARKET_MALGAR_PORT = 9900000002n;
const TEST_MARKET_NGANE_HUB = 9900000003n;
const TEST_MARKET_CARRIER = 9900000004n;
const TEST_MARKET_HEVERTY_REFINERY = 9900000005n;

describe.skipIf(!dbReachable)("Trading & BGS Database Queries Integration Suite", () => {
  let goldId = 0;
  let agronomicId = 0;
  let biowasteId = 0;

  beforeAll(async () => {
    await initCommodityCache();
    goldId = await resolveCommodityId("gold");
    agronomicId = await resolveCommodityId("agronomictreatment");
    biowasteId = await resolveCommodityId("biowaste");

    const nowIso = new Date().toISOString();

    // 1. Seed 3 neighboring star systems with real 3D coordinates around Heverty
    const heverty = await upsertSystem({
      name: TEST_SYS_HEVERTY,
      systemAddress: 9900001001n,
      x: 111.6875,
      y: -61.875,
      z: 55.15625,
      population: 6132875,
      government: "Communism",
      primaryEconomy: "Industrial",
      controllingFaction: TEST_FACTION_PPH,
      updatedAt: nowIso,
    });

    const malgar = await upsertSystem({
      name: TEST_SYS_MALGAR,
      systemAddress: 9900001002n,
      x: 118.25,
      y: -58.125,
      z: 50.5,
      population: 1450000,
      government: "Corporate",
      primaryEconomy: "Agriculture",
      controllingFaction: TEST_FACTION_RIVAL,
      updatedAt: nowIso,
    });

    const ngane = await upsertSystem({
      name: TEST_SYS_NGANE,
      systemAddress: 9900001003n,
      x: 105.0,
      y: -65.0,
      z: 60.0,
      population: 8900000,
      government: "Democracy",
      primaryEconomy: "Refinery",
      controllingFaction: TEST_FACTION_PPH,
      updatedAt: nowIso,
    });

    await upsertSystemFactions(
      heverty.id,
      [
        {
          name: TEST_FACTION_PPH,
          allegiance: "Independent",
          government: "Communism",
          influence: 0.642,
          factionState: "Boom",
          happiness: "Elated",
          activeStates: [{ State: "Boom" }],
          pendingStates: [{ State: "Expansion" }],
          recoveringStates: [],
        },
        {
          name: TEST_FACTION_RIVAL,
          allegiance: "Independent",
          government: "Corporate",
          influence: 0.068,
          factionState: "Retreat",
          happiness: "Discontented",
          activeStates: [{ State: "Retreat" }],
          pendingStates: [],
          recoveringStates: [],
        },
        {
          name: TEST_FACTION_NATIVE_LOW,
          allegiance: "Independent",
          government: "Anarchy",
          influence: 0.01,
          factionState: "None",
          happiness: "Happy",
          activeStates: [],
          pendingStates: [],
          recoveringStates: [],
        },
      ],
      nowIso,
    );

    // 2. Seed station metadata & markets
    // Woodroffe Gateway in Heverty (controlled by PPH)
    await upsertStationMeta({
      marketId: TEST_MARKET_WOODROFFE,
      systemId: heverty.id,
      name: "Woodroffe Gateway",
      stationType: "Coriolis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      distanceToArrivalLs: 268,
      controllingFaction: TEST_FACTION_PPH,
      controllingFactionState: "Boom",
      government: "Communism",
      primaryEconomy: "Industrial",
      hasBlackmarket: false,
      services: ["dock", "commodities", "outfitting"],
      metaUpdatedAt: nowIso,
    });

    await upsertStationMarket({
      marketId: TEST_MARKET_WOODROFFE,
      systemId: heverty.id,
      stationName: "Woodroffe Gateway",
      stationType: "Coriolis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      marketUpdatedAt: nowIso,
      items: [
        // Sells Agronomic Treatment for 3,100 CR (high supply), buys Gold for 58,000 CR
        {
          commodityId: agronomicId,
          meanPrice: 3500,
          buyPrice: 3100,
          stock: 15000,
          stockBracket: 3,
          sellPrice: 2900,
          demand: 0,
          demandBracket: 0,
          statusFlags: ["Producer"],
        },
        {
          commodityId: goldId,
          meanPrice: 47000,
          buyPrice: 0,
          stock: 0,
          stockBracket: 0,
          sellPrice: 58000,
          demand: 8000,
          demandBracket: 3,
          statusFlags: ["Consumer"],
        },
        {
          commodityId: biowasteId,
          meanPrice: 300,
          buyPrice: 450,
          stock: 25000,
          stockBracket: 3,
          sellPrice: 100,
          demand: 0,
          demandBracket: 0,
          statusFlags: ["Producer"],
        },
      ],
    });

    // Malgar Port in Malgar (controlled by Rival Faction)
    await upsertStationMeta({
      marketId: TEST_MARKET_MALGAR_PORT,
      systemId: malgar.id,
      name: "Malgar Port",
      stationType: "Orbis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      distanceToArrivalLs: 410,
      controllingFaction: TEST_FACTION_RIVAL,
      controllingFactionState: "None",
      government: "Corporate",
      primaryEconomy: "Agriculture",
      hasBlackmarket: true,
      services: ["dock", "commodities", "blackmarket"],
      metaUpdatedAt: nowIso,
    });

    await upsertStationMarket({
      marketId: TEST_MARKET_MALGAR_PORT,
      systemId: malgar.id,
      stationName: "Malgar Port",
      stationType: "Orbis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      marketUpdatedAt: nowIso,
      items: [
        // Buys Agronomic Treatment for 31,500 CR (+28,400 CR/t profit from Woodroffe!)
        {
          commodityId: agronomicId,
          meanPrice: 3500,
          buyPrice: 0,
          stock: 0,
          stockBracket: 0,
          sellPrice: 31500,
          demand: 12000,
          demandBracket: 3,
          statusFlags: ["Consumer"],
        },
        // Buys Biowaste for 320 CR (a -130 CR/t budget loss when bought at Woodroffe for 450 CR!)
        {
          commodityId: biowasteId,
          meanPrice: 300,
          buyPrice: 0,
          stock: 0,
          stockBracket: 0,
          sellPrice: 320,
          demand: 0,
          demandBracket: 0,
          statusFlags: [],
        },
        // Buys Gold for 32,000 CR (a -8,000 CR/t heavy loss when bought at Ngane Hub for 40,000 CR!)
        {
          commodityId: goldId,
          meanPrice: 47000,
          buyPrice: 0,
          stock: 0,
          stockBracket: 0,
          sellPrice: 32000,
          demand: 100,
          demandBracket: 1,
          statusFlags: [],
        },
      ],
    });

    // Ngane Hub in Ngane (sells Gold cheap at 40,000 CR)
    await upsertStationMeta({
      marketId: TEST_MARKET_NGANE_HUB,
      systemId: ngane.id,
      name: "Ngane Hub",
      stationType: "Coriolis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      distanceToArrivalLs: 190,
      controllingFaction: TEST_FACTION_PPH,
      controllingFactionState: "Boom",
      metaUpdatedAt: nowIso,
    });

    await upsertStationMarket({
      marketId: TEST_MARKET_NGANE_HUB,
      systemId: ngane.id,
      stationName: "Ngane Hub",
      stationType: "Coriolis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      marketUpdatedAt: nowIso,
      items: [
        {
          commodityId: goldId,
          meanPrice: 47000,
          buyPrice: 40000,
          stock: 9500,
          stockBracket: 3,
          sellPrice: 38000,
          demand: 0,
          demandBracket: 0,
          statusFlags: ["Producer"],
        },
      ],
    });

    // Fleet Carrier in Malgar (to verify BGS undermining excludes carriers as targets)
    await upsertStationMarket({
      marketId: TEST_MARKET_CARRIER,
      systemId: malgar.id,
      stationName: "T9Z-99Q",
      stationType: "FleetCarrier",
      isFleetCarrier: true,
      isColonisationVessel: false,
      maxLandingPad: "L",
      carrierDockingAccess: "all",
      marketUpdatedAt: nowIso,
      items: [
        {
          commodityId: biowasteId,
          meanPrice: 300,
          buyPrice: 0,
          stock: 0,
          stockBracket: 0,
          sellPrice: 440,
          demand: 5000,
          demandBracket: 3,
          statusFlags: [],
        },
      ],
    });

    // Second market in Heverty (Heverty Refinery) for testing internal in-system trade routes
    await upsertStationMeta({
      marketId: TEST_MARKET_HEVERTY_REFINERY,
      systemId: heverty.id,
      name: "Heverty Refinery",
      stationType: "Orbis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      distanceToArrivalLs: 640,
      controllingFaction: TEST_FACTION_RIVAL,
      controllingFactionState: "None",
      metaUpdatedAt: nowIso,
    });

    await upsertStationMarket({
      marketId: TEST_MARKET_HEVERTY_REFINERY,
      systemId: heverty.id,
      stationName: "Heverty Refinery",
      stationType: "Orbis",
      isFleetCarrier: false,
      isColonisationVessel: false,
      maxLandingPad: "L",
      marketUpdatedAt: nowIso,
      items: [
        // Sells Gold at 42,000 CR, which Woodroffe Gateway in the same system buys for 58,000 CR (+16,000 CR/t)
        {
          commodityId: goldId,
          meanPrice: 47000,
          buyPrice: 42000,
          stock: 4000,
          stockBracket: 3,
          sellPrice: 40000,
          demand: 0,
          demandBracket: 0,
          statusFlags: ["Producer"],
        },
      ],
    });
  });

  afterAll(async () => {
    await sql`
      DELETE FROM systems
      WHERE name IN (${TEST_SYS_HEVERTY}, ${TEST_SYS_MALGAR}, ${TEST_SYS_NGANE})
    `;
    await sql`
      DELETE FROM factions
      WHERE name IN (${TEST_FACTION_PPH}, ${TEST_FACTION_RIVAL}, ${TEST_FACTION_NATIVE_LOW})
    `;
  });

  test("finds profitable trade routes (point-to-point and 3D radius search)", async () => {
    const p2p = await findProfitableTradeRoutes({
      fromSystem: TEST_SYS_HEVERTY,
      toSystem: TEST_SYS_MALGAR,
      minPad: "L",
      minStock: 500,
    });

    expect(p2p.origin?.name).toBe(TEST_SYS_HEVERTY);
    expect(p2p.routes.length).toBeGreaterThanOrEqual(1);
    const topRoute = p2p.routes[0]!;
    expect(topRoute.commodity_name).toBe("Agronomic Treatment");
    expect(topRoute.from_station).toBe("Woodroffe Gateway");
    expect(topRoute.to_station).toBe("Malgar Port");
    expect(topRoute.profit_per_ton).toBe(28400);
    expect(topRoute.distance_ly).toBeGreaterThan(8);
    expect(topRoute.distance_ly).toBeLessThan(10);

    // Radius search from Ngane within 20 Ly should find Gold -> Woodroffe Gateway (+18,000 CR/t)
    const radiusRes = await findProfitableTradeRoutes({
      fromSystem: TEST_SYS_NGANE,
      maxDistanceLy: 20,
      minPad: "L",
      minStock: 1000,
    });
    const goldRoute = radiusRes.routes.find(
      (r) => r.commodity_name === "Gold" && r.to_station === "Woodroffe Gateway",
    );
    expect(goldRoute).toBeDefined();
    expect(goldRoute?.profit_per_ton).toBe(18000);
  });

  test("finds profitable internal trade routes within the same system", async () => {
    const internalRes = await findInternalTradeRoutes({
      system: TEST_SYS_HEVERTY,
      minPad: "L",
      minStock: 500,
    });

    expect(internalRes.system?.name).toBe(TEST_SYS_HEVERTY);
    expect(internalRes.routes.length).toBe(1);
    const route = internalRes.routes[0]!;
    expect(route.commodity_name).toBe("Gold");
    expect(route.from_system).toBe(TEST_SYS_HEVERTY);
    expect(route.to_system).toBe(TEST_SYS_HEVERTY);
    expect(route.from_station).toBe("Heverty Refinery");
    expect(route.to_station).toBe("Woodroffe Gateway");
    expect(route.profit_per_ton).toBe(16000);
    expect(route.distance_ly).toBe(0);
  });

  test("finds BGS undermining loss routes and excludes Fleet Carriers as targets", async () => {
    // 1. Budget loss strategy (smallest credit loss per ton first)
    const budgetRoutes = await findUndermineLossRoutes({
      targetSystem: TEST_SYS_MALGAR,
      targetFaction: TEST_FACTION_RIVAL,
      strategy: "budget_loss",
      maxDistanceLy: 30,
    });

    expect(budgetRoutes.length).toBeGreaterThanOrEqual(2);
    // Carrier T9Z-99Q must NEVER appear as a target station
    expect(budgetRoutes.some((r) => r.target_station === "T9Z-99Q")).toBe(false);

    // First route in budget_loss should be Biowaste (-130 CR/t loss) before Gold (-8,000 CR/t loss)
    const biowasteLoss = budgetRoutes.find(
      (r) => r.commodity_name === "Biowaste" && r.from_station === "Woodroffe Gateway",
    );
    expect(biowasteLoss).toBeDefined();
    expect(biowasteLoss?.loss_per_ton).toBe(130);
    expect(biowasteLoss?.target_faction).toBe(TEST_FACTION_RIVAL);

    // 2. Heavy loss strategy (largest credit loss per ton first)
    const heavyRoutes = await findUndermineLossRoutes({
      targetSystem: TEST_SYS_MALGAR,
      targetFaction: TEST_FACTION_RIVAL,
      strategy: "heavy_loss",
      maxDistanceLy: 30,
    });

    const goldLoss = heavyRoutes.find(
      (r) => r.commodity_name === "Gold" && r.from_station === "Ngane Hub",
    );
    expect(goldLoss).toBeDefined();
    expect(goldLoss?.loss_per_ton).toBe(8000);
  });

  test("finds cheapest buying and highest selling prices within radius", async () => {
    const buyRes = await findCheapestCommodityBuy({
      commodityQuery: "Gold",
      nearSystem: TEST_SYS_HEVERTY,
      maxDistanceLy: 20,
      minQuantity: 500,
    });
    expect(buyRes.commodity?.name).toBe("Gold");
    const nganeListing = buyRes.listings.find((l) => l.station_name === "Ngane Hub");
    expect(nganeListing).toBeDefined();
    expect(nganeListing?.buy_price).toBe(40000);

    const sellRes = await findHighestCommoditySell({
      commodityQuery: "Agronomic Treatment",
      nearSystem: TEST_SYS_HEVERTY,
      maxDistanceLy: 20,
      minQuantity: 500,
    });
    expect(sellRes.commodity?.name).toBe("Agronomic Treatment");
    const malgarListing = sellRes.listings.find((l) => l.station_name === "Malgar Port");
    expect(malgarListing).toBeDefined();
    expect(malgarListing?.sell_price).toBe(31500);
  });

  test("lists stations controlled by a Minor Faction with BGS influence %", async () => {
    const pphStations = await findFactionMarkets(TEST_FACTION_PPH);
    expect(pphStations.length).toBe(2);

    const woodroffe = pphStations.find((s) => s.station_name === "Woodroffe Gateway");
    expect(woodroffe).toBeDefined();
    expect(woodroffe?.system_name).toBe(TEST_SYS_HEVERTY);
    expect(woodroffe?.faction_influence).toBeCloseTo(0.642, 3);
    expect(woodroffe?.controlling_faction_state).toBe("Boom");
    expect(woodroffe?.listings_count).toBe(3);
  });

  test("returns commodity listings for a specific market with supply/demand filtering", async () => {
    const allRes = await getStationMarketListings({
      station: "Woodroffe Gateway",
      system: TEST_SYS_HEVERTY,
    });
    expect(allRes.station?.station_name).toBe("Woodroffe Gateway");
    expect(allRes.station?.system_name).toBe(TEST_SYS_HEVERTY);
    expect(allRes.station?.total_listings_count).toBe(3);
    expect(allRes.station?.supply_count).toBe(2);
    expect(allRes.station?.demand_count).toBe(1);
    expect(allRes.listings.length).toBe(3);

    const supplyOnly = await getStationMarketListings({
      station: "Woodroffe Gateway",
      system: TEST_SYS_HEVERTY,
      filter: "supply",
    });
    expect(supplyOnly.listings.length).toBe(2);
    expect(supplyOnly.listings.every((l) => l.buy_price > 0 && l.stock > 0)).toBe(true);

    const demandOnly = await getStationMarketListings({
      station: "Woodroffe Gateway",
      system: TEST_SYS_HEVERTY,
      filter: "demand",
      minDemand: 1000,
    });
    expect(demandOnly.listings.length).toBe(1);
    expect(demandOnly.listings[0]?.commodity_name).toBe("Gold");
    expect(demandOnly.listings[0]?.sell_price).toBe(58000);
  });

  test("generates comprehensive system BGS report and multi-system faction status report", async () => {
    const sysReport = await getSystemBgsReport(TEST_SYS_HEVERTY);
    expect(sysReport.system?.name).toBe(TEST_SYS_HEVERTY);
    expect(sysReport.system?.controlling_faction).toBe(TEST_FACTION_PPH);
    expect(sysReport.factions.length).toBe(3);

    const pphStanding = sysReport.factions[0]!;
    expect(pphStanding.name).toBe(TEST_FACTION_PPH);
    expect(pphStanding.is_controlling).toBe(true);
    expect(pphStanding.is_native).toBe(true);
    expect(pphStanding.influence).toBeCloseTo(0.642, 3);
    expect(pphStanding.active_states).toContain("Boom");
    expect(pphStanding.pending_states).toContain("Expansion");
    expect(pphStanding.controlled_stations_count).toBe(1);

    const rivalStanding = sysReport.factions[1]!;
    expect(rivalStanding.name).toBe(TEST_FACTION_RIVAL);
    expect(rivalStanding.is_controlling).toBe(false);
    expect(rivalStanding.is_native).toBe(false);
    expect(rivalStanding.influence).toBeCloseTo(0.068, 3);

    const nativeLowStanding = sysReport.factions[2]!;
    expect(nativeLowStanding.name).toBe(TEST_FACTION_NATIVE_LOW);
    expect(nativeLowStanding.is_native).toBe(true);
    expect(nativeLowStanding.influence).toBeCloseTo(0.01, 3);

    // Retreat Risk alert should trigger for foreign rival at 6.8%, but NOT for native faction at 1.0%
    expect(
      sysReport.alerts.some(
        (a) => a.includes("Retreat Risk") && a.includes(TEST_FACTION_RIVAL),
      ),
    ).toBe(true);
    expect(
      sysReport.alerts.some(
        (a) => a.includes("Retreat Risk") && a.includes(TEST_FACTION_NATIVE_LOW),
      ),
    ).toBe(false);
    expect(sysReport.stations.length).toBe(2);

    // Multi-system faction status report for PPH
    const factionReport = await getFactionStatusReport({
      factionName: TEST_FACTION_PPH,
      nearSystem: TEST_SYS_HEVERTY,
    });
    expect(factionReport.faction?.name).toBe(TEST_FACTION_PPH);
    expect(factionReport.presences.length).toBe(1);
    const hevertyPresence = factionReport.presences[0]!;
    expect(hevertyPresence.system_name).toBe(TEST_SYS_HEVERTY);
    expect(hevertyPresence.is_controlling_system).toBe(true);
    expect(hevertyPresence.controlled_stations_count).toBe(1);
    expect(hevertyPresence.total_stations_count).toBe(2);
    expect(hevertyPresence.rival_faction_name).toBe(TEST_FACTION_RIVAL);
    expect(hevertyPresence.rival_influence).toBeCloseTo(0.068, 3);
  });
});
