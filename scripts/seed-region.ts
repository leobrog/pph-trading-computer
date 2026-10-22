import { env } from "../src/config/env.ts";
import { closeDatabase, sql } from "../src/db/index.ts";
import {
  initCommodityCache,
  type MarketCommodityItem,
  type NormalizedFactionInput,
  resolveCommodityId,
  upsertStationMarket,
  upsertStationMeta,
  upsertSystem,
  upsertSystemFactions,
} from "../src/db/queries/ingest.ts";
import {
  cleanFdevToken,
  cleanStationName,
  inferMaxLandingPad,
  isColonisationVessel,
  isFleetCarrier,
} from "../src/listener/normalizer.ts";

const SPANSH_SYSTEMS_SEARCH_URL = "https://spansh.co.uk/api/systems/search";
const SPANSH_STATIONS_SEARCH_URL = "https://spansh.co.uk/api/stations/search";

interface SpanshMinorFactionPresence {
  name: string;
  allegiance?: string;
  government?: string;
  influence?: number;
  state?: string;
  active_states?: string[];
  pending_states?: string[];
  recovering_states?: string[];
}

interface SpanshSystemStationSummary {
  market_id?: number;
  name?: string;
  type?: string;
  controlling_minor_faction?: string;
  distance_to_arrival?: number;
  small_pads?: number;
  medium_pads?: number;
  large_pads?: number;
  has_large_pad?: boolean;
  has_market?: boolean;
  services?: Array<{ name?: string } | string>;
}

interface SpanshSystemResult {
  id64?: number;
  name: string;
  x: number;
  y: number;
  z: number;
  population?: number;
  is_being_colonised?: boolean;
  allegiance?: string;
  government?: string;
  primary_economy?: string;
  security?: string;
  controlling_minor_faction?: string;
  controlling_minor_faction_state?: string;
  power?: string[] | string;
  power_state?: string;
  updated_at?: string;
  minor_faction_presences?: SpanshMinorFactionPresence[];
  stations?: SpanshSystemStationSummary[];
}

interface SpanshMarketEntry {
  commodity: string;
  category?: string;
  buy_price?: number;
  supply?: number;
  sell_price?: number;
  demand?: number;
}

interface SpanshStationResult {
  market_id?: number;
  name: string;
  type?: string;
  system_name: string;
  system_id64?: number;
  system_x?: number;
  system_y?: number;
  system_z?: number;
  system_population?: number;
  controlling_minor_faction?: string;
  distance_to_arrival?: number;
  small_pads?: number;
  medium_pads?: number;
  large_pads?: number;
  government?: string;
  primary_economy?: string;
  economies?: Array<{ name?: string; share?: number }>;
  services?: Array<{ name?: string } | string>;
  prohibited_commodities?: Array<{ name?: string } | string>;
  market?: SpanshMarketEntry[];
  market_updated_at?: string;
  updated_at?: string;
}

export interface RegionalSeedOptions {
  centerSystem?: string;
  radiusLy?: number;
  includeMarkets?: boolean;
}

export interface RegionalSeedResult {
  centerSystem: string;
  radiusLy: number;
  systemsUpserted: number;
  stationsUpserted: number;
  factionsUpserted: number;
  marketsUpserted: number;
  listingsUpserted: number;
  durationMs: number;
}

function extractServiceNames(raw?: Array<{ name?: string } | string>): string[] | null {
  if (!Array.isArray(raw)) return null;
  const result: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item : item?.name;
    if (name?.trim()) {
      result.push(name.trim().toLowerCase());
    }
  }
  return result.length > 0 ? result : null;
}

/**
 * Seeds populated systems, stations, minor faction BGS presences, and recent commodity markets
 * within `radiusLy` Light Years of `centerSystem` (defaults to `Heverty`, `50 Ly`) using Spansh's API.
 */
export async function seedRegionAroundSystem(
  options?: RegionalSeedOptions,
): Promise<RegionalSeedResult> {
  const start = performance.now();
  const centerSystem = options?.centerSystem?.trim() || "Heverty";
  const radiusLy = Math.min(150, Math.max(5, options?.radiusLy ?? 50));
  const includeMarkets = options?.includeMarkets ?? true;

  await initCommodityCache();

  // Build display-name -> commodity_id map for Spansh market entries
  const commodityRows = await sql<{ id: number; name: string; symbol: string }[]>`
    SELECT id, name, symbol FROM commodities
  `;
  const commodityByNameOrSymbol = new Map<string, number>();
  for (const row of commodityRows) {
    commodityByNameOrSymbol.set(row.name.toLowerCase(), Number(row.id));
    commodityByNameOrSymbol.set(row.symbol.toLowerCase(), Number(row.id));
  }

  console.log(
    `[RegionalSeed] Fetching populated systems within ${radiusLy} Ly of "${centerSystem}" from Spansh...`,
  );

  let systemsUpserted = 0;
  let stationsUpserted = 0;
  let factionsUpserted = 0;
  let marketsUpserted = 0;
  let listingsUpserted = 0;

  const systemIdByName = new Map<string, number>();

  // 1. Paginate populated systems within radiusLy of centerSystem
  const pageSize = 500;
  let page = 0;
  let totalSystems = 0;

  do {
    const response = await fetch(SPANSH_SYSTEMS_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PPH-Trading-Computer/1.0",
      },
      body: JSON.stringify({
        filters: {
          distance: { min: "0", max: String(radiusLy) },
          population: { min: 1 },
        },
        reference_system: centerSystem,
        size: pageSize,
        page,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) {
      throw new Error(`Spansh systems search failed with status ${response.status}`);
    }

    const data = (await response.json()) as {
      count?: number;
      results?: SpanshSystemResult[];
    };

    totalSystems = data.count ?? 0;
    const results = data.results ?? [];
    if (results.length === 0) break;

    const chunkSize = 20;
    for (let i = 0; i < results.length; i += chunkSize) {
      const chunk = results.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (sys) => {
          if (!sys.name || typeof sys.x !== "number") return;

          const updatedAt = sys.updated_at || new Date().toISOString();
          const controllingPower = Array.isArray(sys.power)
            ? sys.power[0] ?? null
            : (sys.power ?? null);

          const sysRecord = await upsertSystem({
            name: sys.name,
            systemAddress: sys.id64 ?? null,
            x: sys.x,
            y: sys.y,
            z: sys.z,
            population: sys.population && sys.population > 0 ? sys.population : 1,
            isUnderColonisation: Boolean(sys.is_being_colonised),
            allegiance: cleanFdevToken(sys.allegiance),
            government: cleanFdevToken(sys.government),
            primaryEconomy: cleanFdevToken(sys.primary_economy),
            security: cleanFdevToken(sys.security),
            controllingFaction: sys.controlling_minor_faction ?? null,
            controllingPower,
            powerplayState: sys.power_state ?? null,
            updatedAt,
          });

          systemIdByName.set(sys.name.toLowerCase(), sysRecord.id);
          systemsUpserted++;

          if (
            Array.isArray(sys.minor_faction_presences) &&
            sys.minor_faction_presences.length > 0
          ) {
            const normalizedFactions: NormalizedFactionInput[] =
              sys.minor_faction_presences
                .filter((f) => f?.name)
                .map((f) => {
                  const mapStateStrings = (arr?: string[]) =>
                    Array.isArray(arr)
                      ? arr
                          .map((s) => cleanFdevToken(s) ?? s)
                          .filter((s): s is string => Boolean(s && s !== "None"))
                          .map((State) => ({ State }))
                      : [];
                  const active = mapStateStrings(f.active_states);
                  if (active.length === 0 && f.state && f.state !== "None") {
                    active.push({ State: cleanFdevToken(f.state) ?? f.state });
                  }
                  return {
                    name: f.name.trim(),
                    allegiance: cleanFdevToken(f.allegiance),
                    government: cleanFdevToken(f.government),
                    influence: typeof f.influence === "number" ? f.influence : null,
                    factionState: cleanFdevToken(f.state),
                    happiness: null,
                    activeStates: active,
                    pendingStates: mapStateStrings(f.pending_states),
                    recoveringStates: mapStateStrings(f.recovering_states),
                  };
                });

            await upsertSystemFactions(sysRecord.id, normalizedFactions, updatedAt);
            factionsUpserted += normalizedFactions.length;
          }

          if (Array.isArray(sys.stations)) {
            for (const st of sys.stations) {
              if (!st.market_id || !st.name) continue;

              const colonisation = isColonisationVessel({
                stationName: st.name,
                stationType: st.type,
              });
              const carrier = !colonisation && isFleetCarrier(st.type, st.name);
              if (carrier) continue;

              const cleanedName = cleanStationName(st.name);
              const pads = {
                Small: st.small_pads ?? 0,
                Medium: st.medium_pads ?? 0,
                Large: st.large_pads ?? (st.has_large_pad ? 1 : 0),
              };
              const maxPad = inferMaxLandingPad(pads, st.type, colonisation);
              const services = extractServiceNames(st.services);
              const hasBlackmarket = services
                ? services.some(
                    (s) => s.includes("black market") || s.includes("blackmarket"),
                  )
                : false;

              await upsertStationMeta({
                marketId: st.market_id,
                systemId: sysRecord.id,
                name: cleanedName,
                stationType: st.type ?? null,
                isFleetCarrier: false,
                isColonisationVessel: colonisation,
                maxLandingPad: maxPad,
                padSmall: st.small_pads ?? null,
                padMedium: st.medium_pads ?? null,
                padLarge: st.large_pads ?? null,
                distanceToArrivalLs: st.distance_to_arrival ?? null,
                controllingFaction:
                  st.controlling_minor_faction &&
                  st.controlling_minor_faction.toLowerCase() !== "fleetcarrier"
                    ? st.controlling_minor_faction
                    : null,
                hasBlackmarket,
                services,
                metaUpdatedAt: updatedAt,
              });
              stationsUpserted++;
            }
          }
        }),
      );
    }

    page++;
  } while (page * pageSize < totalSystems && page < 10);

  // 2. Fetch active stations with recent commodity markets within radiusLy
  if (includeMarkets) {
    const stationTtlCutoff = new Date(
      Date.now() - env.ttl.stationMarketHours * 3600 * 1000,
    ).toISOString();
    const carrierTtlCutoffMs = Date.now() - env.ttl.carrierMarketHours * 3600 * 1000;
    const nowIso = new Date().toISOString();

    let stPage = 0;
    let totalMarketStations = 0;

    do {
      const response = await fetch(SPANSH_STATIONS_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "PPH-Trading-Computer/1.0",
        },
        body: JSON.stringify({
          filters: {
            distance: { min: "0", max: String(radiusLy) },
            has_market: { value: true },
            market_updated_at: {
              value: [stationTtlCutoff, nowIso],
              comparison: "<=>",
            },
          },
          reference_system: centerSystem,
          size: pageSize,
          page: stPage,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (!response.ok) {
        console.warn(
          `[RegionalSeed] Spansh stations search returned status ${response.status}`,
        );
        break;
      }

      const data = (await response.json()) as {
        count?: number;
        results?: SpanshStationResult[];
      };

      totalMarketStations = data.count ?? 0;
      const results = data.results ?? [];
      if (results.length === 0) break;

      const stChunkSize = 15;
      for (let i = 0; i < results.length; i += stChunkSize) {
        const chunk = results.slice(i, i + stChunkSize);
        await Promise.all(
          chunk.map(async (st) => {
            if (!st.market_id || !st.name || !st.system_name || !Array.isArray(st.market)) {
              return;
            }

            const marketUpdatedAt = st.market_updated_at || st.updated_at || nowIso;
            const colonisation = isColonisationVessel({
              stationName: st.name,
              stationType: st.type,
              government: st.government,
            });
            const carrier = !colonisation && isFleetCarrier(st.type, st.name);

            if (carrier && Date.parse(marketUpdatedAt) < carrierTtlCutoffMs) {
              return;
            }

            let sysId = systemIdByName.get(st.system_name.toLowerCase());
            if (!sysId) {
              const sysPop = st.system_population ?? 0;
              if (sysPop <= 0 && !colonisation) {
                return;
              }
              const sysRec = await upsertSystem({
                name: st.system_name,
                systemAddress: st.system_id64 ?? null,
                x: st.system_x ?? null,
                y: st.system_y ?? null,
                z: st.system_z ?? null,
                population: sysPop > 0 ? sysPop : null,
                isUnderColonisation: colonisation,
                updatedAt: marketUpdatedAt,
              });
              sysId = sysRec.id;
              systemIdByName.set(st.system_name.toLowerCase(), sysId);
            }

            const cleanedName = cleanStationName(st.name);
            const pads = {
              Small: st.small_pads ?? 0,
              Medium: st.medium_pads ?? 0,
              Large: st.large_pads ?? 0,
            };
            const maxPad = inferMaxLandingPad(
              pads,
              st.type ?? (carrier ? "FleetCarrier" : null),
              colonisation,
            );
            const services = extractServiceNames(st.services);
            const hasBlackmarket = services
              ? services.some(
                  (s) => s.includes("black market") || s.includes("blackmarket"),
                )
              : false;

            await upsertStationMeta({
              marketId: st.market_id,
              systemId: sysId,
              name: cleanedName,
              stationType: st.type ?? (carrier ? "FleetCarrier" : null),
              isFleetCarrier: carrier,
              isColonisationVessel: colonisation,
              maxLandingPad: maxPad,
              padSmall: st.small_pads ?? null,
              padMedium: st.medium_pads ?? null,
              padLarge: st.large_pads ?? null,
              distanceToArrivalLs: st.distance_to_arrival ?? null,
              controllingFaction:
                st.controlling_minor_faction &&
                st.controlling_minor_faction.toLowerCase() !== "fleetcarrier"
                  ? st.controlling_minor_faction
                  : null,
              government: cleanFdevToken(st.government),
              primaryEconomy: cleanFdevToken(st.primary_economy),
              hasBlackmarket,
              services,
              metaUpdatedAt: marketUpdatedAt,
            });

            const items: MarketCommodityItem[] = [];
            for (const entry of st.market) {
              if (!entry.commodity) continue;
              const key = entry.commodity.trim().toLowerCase();
              let commodityId = commodityByNameOrSymbol.get(key);
              if (commodityId === undefined) {
                commodityId = await resolveCommodityId(entry.commodity);
                commodityByNameOrSymbol.set(key, commodityId);
              }

              items.push({
                commodityId,
                meanPrice: 0,
                buyPrice: Math.max(0, Math.trunc(entry.buy_price ?? 0)),
                stock: Math.max(0, Math.trunc(entry.supply ?? 0)),
                stockBracket: (entry.supply ?? 0) > 0 ? 2 : 0,
                sellPrice: Math.max(0, Math.trunc(entry.sell_price ?? 0)),
                demand: Math.max(0, Math.trunc(entry.demand ?? 0)),
                demandBracket: (entry.demand ?? 0) > 0 ? 2 : 0,
                statusFlags: null,
              });
            }

            const marketRes = await upsertStationMarket({
              marketId: st.market_id,
              systemId: sysId,
              stationName: cleanedName,
              stationType: st.type ?? (carrier ? "FleetCarrier" : null),
              isFleetCarrier: carrier,
              isColonisationVessel: colonisation,
              maxLandingPad: maxPad,
              marketUpdatedAt,
              items,
            });

            if (marketRes.updated) {
              marketsUpserted++;
              listingsUpserted += marketRes.listingsCount;
            }
          }),
        );
      }

      stPage++;
    } while (stPage * pageSize < totalMarketStations && stPage < 5);
  }

  const durationMs = Math.round(performance.now() - start);
  console.log(
    `[RegionalSeed] Completed "${centerSystem}" (${radiusLy} Ly) in ${(durationMs / 1000).toFixed(1)}s: ` +
      `${systemsUpserted} systems, ${stationsUpserted} stations, ${factionsUpserted} faction presences, ` +
      `${marketsUpserted} active markets (${listingsUpserted.toLocaleString()} commodity listings).`,
  );

  return {
    centerSystem,
    radiusLy,
    systemsUpserted,
    stationsUpserted,
    factionsUpserted,
    marketsUpserted,
    listingsUpserted,
    durationMs,
  };
}

if (import.meta.main) {
  const argSystem = process.argv[2] || process.env.SEED_CENTER_SYSTEM || "Heverty";
  const argRadius = process.argv[3]
    ? Number.parseFloat(process.argv[3])
    : Number.parseFloat(process.env.SEED_RADIUS_LY || "50");

  try {
    await seedRegionAroundSystem({
      centerSystem: argSystem,
      radiusLy: Number.isNaN(argRadius) ? 50 : argRadius,
    });
  } catch (err) {
    console.error("[RegionalSeed] Failed:", err);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
