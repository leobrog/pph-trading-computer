# Phase 2: EDDN ZeroMQ Listener & TTL Cleanup Service

## Objective
Implement the resilient ZeroMQ listener (`src/listener/`) that streams live data from `tcp://eddn.edcd.io:9500`, filters and normalizes relevant EDDN events (`commodity/3` and `journal/1`), persists market and BGS data into PostgreSQL via `Bun.sql`, and runs a scheduled TTL cleanup job to purge expired records.

---

## 1. ZMTP 3.0 Stream Client (`src/listener/zmtp-client.ts`)

Built on `Bun.connect()` and `node:zlib` (`inflateSync`):
* **Handshake:**
  1. Sends 64-byte ZMTP 3.0 `NULL` greeting upon TCP connection open.
  2. Waits for the 64-byte peer greeting from `eddn.edcd.io:9500`.
  3. Sends `READY` command (`Socket-Type: SUB`) followed by `SUBSCRIBE` command (`""` topic).
* **Frame Parser:**
  * Maintains a ring/growing `Buffer` for incoming TCP chunks.
  * Parses ZMTP frame headers:
    * Short frames (`(flags & 0x02) === 0`): 1-byte `flags` + 1-byte `length`.
    * Long frames (`(flags & 0x02) !== 0`): 1-byte `flags` + 8-byte `uint64BE` `length`.
    * Command frames (`(flags & 0x04) !== 0`): Responds to ZMTP `PING` commands with `PONG` if received.
    * Message frames (`(flags & 0x04) === 0`): Decompresses frame body with `inflateSync`, parses JSON, and emits the `EddnEnvelope`.
* **Resilience & Reconnection:**
  * **Idle Watchdog Timer:** If no bytes are received from `eddn.edcd.io:9500` within `60 seconds` (since EDDN normally sends 15–50 msgs/sec), closes the socket and triggers reconnect.
  * **Exponential Backoff:** Reconnects after `1s -> 2s -> 4s -> 8s -> max 30s` with jitter on disconnect or DNS/TCP error.

---

## 2. Schema Router & Filters (`src/listener/router.ts`)

1. **Legacy Client Filter:**
   * Inspect `header.gameversion` and `message.odyssey` / `message.horizons`.
   * Drop messages from Legacy 3.8 clients (e.g., `gameversion` starting with `"3."` or missing on legacy schemas) so Legacy galaxy data never contaminates Live galaxy prices.
2. **Timestamp Sanity & Freshness Gate:**
   * Parse `message.timestamp` and `header.gatewayTimestamp`.
   * Drop messages where `message.timestamp` is older than our TTL cutoff (e.g. `NOW() - TTL_STATION_MARKET_HOURS`), preventing EDDiscovery historical log replays from polluting the database.
   * Clamp or drop messages where `message.timestamp > NOW() + 10 minutes` (client clock skew).
3. **Schema Dispatch:**
   * `https://eddn.edcd.io/schemas/commodity/3` $\rightarrow$ `handleCommodityMessage()`
   * `https://eddn.edcd.io/schemas/journal/1` $\rightarrow$ check `message.event`:
     * `"Docked"` $\rightarrow$ `handleDockedEvent()`
     * `"FSDJump"` $\rightarrow$ `handleSystemEvent()`
     * `"Location"` $\rightarrow$ `handleLocationEvent()` (calls both system and station handlers if `Docked === true`)
     * `"CarrierJump"` $\rightarrow$ `handleCarrierJumpEvent()`
     * All other `journal/1` events (`"Scan"`, `"SAASignalsFound"`, `"CodexEntry"`) $\rightarrow$ ignored immediately.

---

## 3. Event Handlers & Normalization (`src/listener/handlers/`)

### A. String, Colonisation Vessel & Pad Size Normalizer (`src/listener/normalizer.ts`)
* **Token Stripping:** Converts FDev localization keys:
  * `"$economy_Agri;"` $\rightarrow$ `"Agriculture"`
  * `"$government_Communism;"` $\rightarrow$ `"Communism"`
  * `"$SYSTEM_SECURITY_high;"` $\rightarrow$ `"High"`
  * `"$EXT_PANEL_ColonisationShip; Shin Enterprise"` $\rightarrow$ `"Colonisation Ship: Shin Enterprise"`
* **Colonisation Vessel Detection (`isColonisationVessel`):**
  * Returns `true` if:
    * Raw `stationName` / `StationName` starts with `"$EXT_PANEL_ColonisationShip;"` or `"System Colonisation Ship"` or `"Orbital Construction Site"` or `"Planetary Construction Site"`, OR
    * `StationGovernment === "$government_Megaconstruction;"`, OR
    * `StationServices` includes `"colonisationcontribution"`.
* **Landing Pad Inference:**
  * If `LandingPads` object is present (`{ Small, Medium, Large }`):
    * `Large > 0 ? 'L' : Medium > 0 ? 'M' : Small > 0 ? 'S' : null`
  * Else infer from `stationType`:
    * `Coriolis | Orbis | Ocellus | Bernal | AsteroidBase | CraterPort | CraterOutpost | SurfaceStation | MegaShip | FleetCarrier` $\rightarrow$ `'L'`
    * `Outpost` $\rightarrow$ `'M'`
    * `OnFootSettlement` $\rightarrow$ `null` (until a `Docked` event provides exact `LandingPads`).

### B. `commodity/3` Handler (`src/listener/handlers/commodity.handler.ts`)
1. Detect `is_colonisation_vessel` and `is_fleet_carrier` (`stationType === "FleetCarrier"` or callsign regex `^[A-Z0-9]{3}-[A-Z0-9]{3}$`).
2. **Uninhabited System Gate:**
   * If `is_fleet_carrier` is `true` and `is_colonisation_vessel` is `false`, check if `systemName` is already known as a populated system (`population > 0`) or under colonisation (`is_under_colonisation = true`), or verify via the EDSM resolver (`showInformation=1`) before keeping a Fleet Carrier market in an uninhabited system.
   * If `is_colonisation_vessel` is `true`, upsert `systems` with `is_under_colonisation = true`.
3. Upsert `stations` by `marketId`:
   * Update `system_id` (handles Fleet Carriers that moved systems!), `name`, `station_type`, `is_fleet_carrier`, `is_colonisation_vessel`, `carrier_docking_access`, `economies`, `prohibited_commodities`, `market_updated_at`.
   * Only proceed with `market_listings` update if `EXCLUDED.market_updated_at >= stations.market_updated_at`.
4. Map symbolic commodity names (`item.name.toLowerCase()`) using an in-memory `Map<string, number>` cache loaded from `commodities` at startup (if an unknown symbol appears, insert it into `commodities` and add to the cache).
5. Batch-upsert all items into `market_listings` in a single `UNNEST(...)` query and delete any stale listings for that `market_id` where `updated_at < message.timestamp`.
6. If the system's `x, y, z` coordinates (or `population`) are still `NULL`, enqueue `systemName` into the non-blocking **Coordinate & Population Resolver Queue**.

### C. `journal/1` Handler (`src/listener/handlers/journal.handler.ts`)
* **Strict Uninhabited System Filter:**
  * For `FSDJump`, `Location`, and `CarrierJump`:
    * If `Population > 0`: Upsert into `systems` (with `population`, `x`, `y`, `z`, `allegiance`, `government`, `primary_economy`, `security`, `controlling_faction`, `controlling_power`, `powerplay_state`) and batch-upsert `factions` + `system_factions`.
    * If `Population === 0` or `Population == null`:
      * Check if `event === "Docked"` (or `Location` with `Docked === true`) at an active **Colonisation Vessel** (`isColonisationVessel === true`). If so, upsert the system with `is_under_colonisation = true` and `StarPos` `[x, y, z]`.
      * Otherwise, only `UPDATE systems SET x = $1, y = $2, z = $3, system_address = $4 WHERE name = $5 AND is_under_colonisation = true` (updating coordinates if the system is already tracked as under active colonisation) — **never insert uninhabited systems**!
* **`Docked` Station Metadata Upsert:**
  * If the station is a Colonisation Vessel (`isColonisationVessel === true`), ensure the parent system is upserted with `is_under_colonisation = true` and `StarPos`.
  * If the station is NOT a Colonisation Vessel and the parent system has `Population === 0` and `is_under_colonisation === false`, ignore the event (e.g., someone docking at a Fleet Carrier in an empty deep-space system).
  * Upserts `stations` by `MarketID` with `distance_to_arrival_ls` (`DistFromStarLS`), `pad_small`, `pad_medium`, `pad_large`, `max_landing_pad`, `controlling_faction` (`StationFaction.Name`), `controlling_faction_state` (`StationFaction.FactionState`), `government`, `primary_economy`, `economies`, `services` (`StationServices`), `has_blackmarket` (`StationServices.includes("blackmarket")`), `is_colonisation_vessel`, and `meta_updated_at`.

### D. Lazy Coordinate & Population Resolver (`src/listener/coord-resolver.ts`)
* When a `commodity/3` message arrives for a system whose `x, y, z` or `population` is `NULL`, a rate-limited background queue (max 1 req / 2 seconds) queries `https://www.edsm.net/api-v1/system?systemName=...&showCoordinates=1&showId=1&showInformation=1`.
* Updates `systems(x, y, z, system_address, population)`.
* If EDSM reports no population (`information` is empty / `population = 0`) AND the system has no active colonisation vessel (`is_colonisation_vessel = true`), the resolver deletes the uninhabited system (and its transient carrier station via `ON DELETE CASCADE`).

---

## 4. TTL Cleanup Worker (`src/listener/ttl-worker.ts`)

Runs automatically on startup and every `TTL_CLEANUP_INTERVAL_MINUTES` (default: `15` minutes):

| Target | Default TTL Env Variable | Default Value | Rationale |
| :--- | :--- | :--- | :--- |
| Fleet Carrier Market Listings | `TTL_CARRIER_MARKET_HOURS` | `48` hours (2 days) | Carrier orders/stock change rapidly |
| Station & Colonisation Market Listings | `TTL_STATION_MARKET_HOURS` | `168` hours (7 days) | Station markets persist across BGS ticks; keeps smaller Bubble ports searchable |
| Inactive Fleet Carriers & Colonisation Vessels | `TTL_TRANSIENT_STATION_DAYS` | `14` days | Removes decommissioned/moved carriers and completed/expired colonisation vessels |
| Uninhabited Systems without Colonisation Vessel | *(Immediate on every run)* | `0` (Immediate) | Deletes any system with `COALESCE(population, 0) = 0` that has no active `is_colonisation_vessel = true` station |
| Stale `system_factions` BGS States | `TTL_FACTION_STATE_DAYS` | `14` days | Keeps BGS influence/states fresh while retaining permanent populated system/station coordinates & pad metadata |

Logs a summary after each run:
`[TTL Worker] Purged 1,420 expired market listings, 12 stale stations, 45 system_factions in 48ms`.

---

## 5. Verification Criteria for Phase 2
* Running `bun run src/listener/index.ts` connects to `tcp://eddn.edcd.io:9500`, logs incoming `commodity/3` and `journal/1` events, and populates `systems`, `stations`, `factions`, `system_factions`, and `market_listings`.
* Unit tests verify `normalizer.ts`, timestamp rejection of stale historical logs, and `zmtp-client.ts` framing.
