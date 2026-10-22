# Research: EDDN Protocol, Schemas & Elite Dangerous Third-Party Ecosystem

## 1. Overview of EDDN (Elite Dangerous Data Network)

The **Elite Dangerous Data Network (EDDN)**, maintained by the Elite Dangerous Community Developers ([EDCD/EDDN](https://github.com/EDCD/EDDN)), is a real-time publish/subscribe relay for anonymized player telemetry and market data.

* **Live ZeroMQ Endpoint:** `tcp://eddn.edcd.io:9500`
* **Transport Pattern:** ZeroMQ `PUB`/`SUB` over TCP (ZMTP 3.0).
* **Topic Filtering:** Subscription must use the empty topic `""` (subscribe to all messages). As noted in EDDN's developer documentation, the relay does not perform server-side topic filtering; filtering by `$schemaRef` happens on the client after decompression.
* **Payload Compression:** Every ZeroMQ message frame body is compressed with `zlib` (typically header `0x78 0x9c` or `0x78 0x5e`) and decompresses to a UTF-8 JSON object.
* **Throughput:** Typically **15 to 60 messages per second** depending on peak player hours (roughly 1.5M–3.5M messages/day), with bursts during Community Goals or major updates.

### Envelope Structure

Every EDDN JSON message conforms to a standard three-key root structure:

```json
{
  "$schemaRef": "https://eddn.edcd.io/schemas/commodity/3",
  "header": {
    "uploaderID": "35a510deafa3fef4c2470fa5f639e99f85d3a75326dc92dd71a3d4b492b4626d",
    "softwareName": "E:D Market Connector [Windows]",
    "softwareVersion": "6.1.3",
    "gameversion": "4.4.2.0",
    "gamebuild": "r334473/r0 ",
    "gatewayTimestamp": "2026-10-22T16:12:25.575985Z"
  },
  "message": { ... }
}
```

> [!WARNING]
> **Legacy / Non-Odyssey Filtering (`gameversion` & `horizons`/`odyssey` flags)**
> Since Frontier split Elite Dangerous into "Legacy" (3.8, console/old PC) and "Live" (4.0+ Horizons/Odyssey codebase), third-party tools targeting the Live galaxy **must filter out Legacy 3.8 clients** (where `header.gameversion` starts with `"3."` or `message.odyssey` is absent/false on older schemas) so that Legacy market prices do not overwrite Live galaxy prices.

---

## 2. Relevant EDDN Schemas to Watch

A critical finding from inspecting live EDDN traffic is that **`commodity/3` alone is not sufficient** for a complete trading and BGS undermining computer. While `commodity/3` provides commodity prices, stock, and demand, it **omits**:
1. **3D System Coordinates (`StarPos`: `[x, y, z]`)** — needed to calculate jump distances between systems.
2. **Station Distance from Arrival Star (`DistFromStarLS`)** — needed so traders don't get routed to stations 0.22 Ly (e.g., Hutton Orbital) away without warning.
3. **Landing Pad Sizes (`LandingPads`)** — needed to filter out Outposts/Odyssey settlements when flying a Large-pad hauler (Type-9 Heavy, Imperial Cutter, Panther Clipper).
4. **Station Controlling Faction (`StationFaction`) & System Factions (`Factions`)** — essential for **People's Party of Heverty (PPH)** BGS operations, such as finding stations controlled by a specific target faction to undermine via loss trading.

Therefore, the listener should subscribe to and process **two primary schemas** (and optionally one secondary schema):

### A. Commodity Schema v3 (`https://eddn.edcd.io/schemas/commodity/3`)

Triggered when a player opens a station's Commodity Market (`Market.json`) or when a companion tool queries Frontier's CAPI `/market` endpoint.

* **Required Fields in `message`:**
  * `systemName` (`string`): Star system name.
  * `stationName` (`string`): Station, settlement, megaship, or Fleet Carrier callsign.
  * `marketId` (`integer` / **64-bit BIGINT**): Unique identifier for the market (e.g., `4314617603`).
  * `timestamp` (`string`, ISO 8601): When the market snapshot was recorded by the game client.
  * `commodities` (`array`):
    * `name` (`string`): Symbolic lowercase commodity identifier (e.g., `"advancedcatalysers"`, `"gold"`). Note: `$` prefix and `_name;` suffix are stripped by uploaders.
    * `meanPrice` (`integer`): Galactic average price.
    * `buyPrice` (`integer`): Price to **buy from** this station (`0` if not sold here).
    * `stock` (`integer`): Units available to buy.
    * `stockBracket` (`0 | 1 | 2 | 3 | ""`): Supply level (`0` = none, `1` = Low, `2` = Med, `3` = High).
    * `sellPrice` (`integer`): Price the station **pays when you sell to** it (`0` if not bought here).
    * `demand` (`integer`): Units demanded by the station.
    * `demandBracket` (`0 | 1 | 2 | 3 | ""`): Demand level (`0` = none, `1` = Low, `2` = Med, `3` = High).
    * `statusFlags` (`string[]`, optional): e.g., `"Producer"`, `"Consumer"`, `"Rare"`.
* **Optional Fields in `message`:**
  * `stationType` (`string`): e.g., `"Coriolis"`, `"Orbis"`, `"Outpost"`, `"CraterPort"`, `"OnFootSettlement"`, `"FleetCarrier"`.
  * `carrierDockingAccess` (`string`): `"all"`, `"friends"`, `"squadron"`, `"squadronfriends"`, `"none"`. (Crucial: Fleet Carriers with docking access != `"all"` should be excluded or flagged in public trade queries!)
  * `economies` (`array` of `{ name, proportion }`): Station economy breakdown (present in CAPI uploads).
  * `prohibited` (`string[]`): Symbolic names of commodities illegal/prohibited at this market (present in CAPI uploads).

### B. Journal Schema v1 (`https://eddn.edcd.io/schemas/journal/1`)

We should filter `journal/1` messages by `message.event` and process **4 specific journal events** (ignoring high-volume exploration events like `Scan`, `SAASignalsFound`, and `CodexEntry` which account for >70% of `journal/1` traffic):

| `message.event` | Why We Need It | Key Fields Extracted |
| :--- | :--- | :--- |
| **`Docked`** | Enriches station metadata whenever a commander docks. | `MarketID`, `StationName`, `StationType`, `StarSystem`, `SystemAddress`, `StarPos` `[x,y,z]`, `DistFromStarLS`, `LandingPads` (`{Small, Medium, Large}`), `StationFaction` (`{Name, FactionState}`), `StationEconomy`, `StationEconomies`, `StationGovernment`, `StationServices` (e.g. `"blackmarket"`, `"commodities"`), `CarrierDockingAccess` |
| **`FSDJump`** | Updates star system 3D coordinates, population, security, and minor faction BGS states/influence on jump. | `StarSystem`, `SystemAddress`, `StarPos` `[x,y,z]`, `Population`, `SystemSecurity`, `SystemEconomy`, `SystemGovernment`, `SystemAllegiance`, `SystemFaction` (`{Name, FactionState}`), `Factions` (`[{Name, FactionState, Government, Influence, Allegiance, Happiness, ActiveStates, PendingStates, RecoveringStates}]`), Powerplay 2.0 fields (`ControllingPower`, `PowerplayState`) |
| **`Location`** | Emitted when a player logs into the game. Contains system coordinates + factions, and if logged in while docked (`Docked: true`), full station metadata. | Same system & faction fields as `FSDJump`, plus `MarketID`, `StationName`, `StationType`, `DistFromStarLS`, `StationFaction`, `StationServices` when `Docked === true` |
| **`CarrierJump`** | Emitted when a Fleet Carrier jumps to a new star system. Without this, a Fleet Carrier's `MarketID` remains associated with its old system until someone docks and uploads again. | `MarketID`, `StationName`, `StationType`, `StarSystem`, `SystemAddress`, `StarPos` `[x,y,z]` |

### C. Black Market Schema v1 (`https://eddn.edcd.io/schemas/blackmarket/1`) — *Optional / BGS Bonus*

Triggered when a commander sells goods to a station's Black Market (`MarketSell` with illegal/stolen goods).
* Contains `systemName`, `stationName`, `marketId`, `timestamp`, `name` (commodity symbol), `sellPrice`, `prohibited` (`boolean`).
* Can be used to record confirmed Black Market sell prices for BGS undermining operations.

---

## 3. Data Hygiene & Edge Cases in EDDN

1. **Historical Log Replays (Stale Timestamps):**
   * Players using tools like EDDiscovery frequently batch-upload old journal logs from weeks or months ago.
   * In live traffic, `message.timestamp` can be much older than `header.gatewayTimestamp`.
   * **Mitigation:**
     1. Reject any message whose `message.timestamp` is older than our configured TTL window, or more than 10 minutes ahead of `header.gatewayTimestamp` (clock skew protection).
     2. In PostgreSQL `ON CONFLICT DO UPDATE` queries, always guard updates with `WHERE EXCLUDED.updated_at >= table.updated_at` so an out-of-order older packet never overwrites fresher market prices or faction states.
2. **64-bit Identifiers:**
   * Both `MarketID` (e.g. `4314617603`) and `SystemAddress` (e.g. `22641591397905`) exceed 32-bit signed integer limits (`2,147,483,647`). They **must** be stored as `BIGINT` in PostgreSQL.
3. **Localization Strings & Colonisation Prefixes:**
   * Some journal fields contain raw FDev tokens like `"$economy_Colony;"`, `"$government_Democracy;"`, `"$SYSTEM_SECURITY_high;"`, or station names like `"$EXT_PANEL_ColonisationShip; Shin Enterprise"`.
   * The listener should normalize these strings on ingestion (e.g., stripping `$economy_...;` / `$government_...;` wrappers or keeping both raw and display values).
4. **Fleet Carriers vs. Permanent Stations:**
   * Fleet Carriers (`stationType === "FleetCarrier"` or callsign matching `^[A-Z0-9]{3}-[A-Z0-9]{3}$`) move between systems, have player-controlled pricing, have restricted docking access (`carrierDockingAccess`), and **do not have a controlling Minor Faction for BGS influence**.
   * BGS undermining queries must **always exclude Fleet Carriers** (and Colonisation Ships) because trading with a Fleet Carrier has zero effect on Minor Faction BGS influence.
   * Normal profit trade queries should allow toggling Fleet Carriers on/off (and default to `carrierDockingAccess = 'all'` when included).

---

## 4. Elite Dangerous BGS Mechanics for Trade & Undermining

Since this application is built for the **People's Party of Heverty (PPH)** (an Independent Communist minor faction based in **Heverty**), understanding how Elite Dangerous's Background Simulation (BGS) processes trade is essential for designing the database and Discord commands:

### How Trade Affects BGS Influence
* **Target of Influence:** Trade transactions only affect the **controlling faction of the station (`StationFaction`)** where the goods are **sold** (or bought, in specific deficit states, though selling is the primary BGS lever).
* **Positive Trade (Reinforcing a Faction):**
  * Selling commodities with positive demand (`demand > 0` or `demandBracket >= 2`) for a **profit** (`sellPrice > player's purchase buyPrice`) increases the station owner's Influence (INF) and drives positive economic states.
* **Negative / Loss Trade (Undermining a Faction's Economy & Influence):**
  * Buying commodities at Station A for `buyPrice` and selling them at Target Station B (controlled by the target enemy faction) for `sellPrice < buyPrice` (i.e. **a net credit loss**, `profit_per_ton = sellPrice - buyPrice < 0`) inflicts **negative influence** on Target Station B's controlling faction.
  * **Important Nuances for the `/undermine-trade` Command:**
    1. **Station Owner Filter:** Users often want to undermine a *specific faction* in a *specific system* (or any station owned by that faction). Storing `controlling_faction` on the `stations` table allows querying: *"Find the best loss trade into any station in system X (or controlled by Faction Y)"*.
    2. **Loss Trade Efficiency Criteria:** Depending on the BGS strategy, commanders look for either:
       * **Minimum Credit Loss ("Cheap Undermining"):** A small loss per ton (e.g., `-10 CR/t` to `-500 CR/t`) with high supply at the source station and short travel distance, allowing commanders to dump thousands of tons without going bankrupt; OR
       * **Maximum Credit Loss / High Volume Dumping:** Selling expensive commodities at a steep loss or dumping into zero-demand markets (`demandBracket = 0`) where the station buys well below galactic average.
       * Supporting both sorting modes (`min-loss` vs `max-loss`) and a `max_loss_per_ton` cap in the command makes the tool significantly more useful for BGS coordinators.
    3. **Black Market Undermining:** Selling prohibited commodities (`prohibited` array in `commodity/3`) at a station that has a `"blackmarket"` in `StationServices` (and is not controlled by an Anarchy faction) is another major BGS undermining lever. Because we receive both `prohibited` commodities (`commodity/3`) and `StationServices` (`Docked`), our database can also power a `/blackmarket-undermine` or include prohibited-goods sourcing!

---

## 5. Third-Party Tools & Datasets to Leverage

Because EDDN is a live stream with no historical replay, a freshly deployed instance starts with an empty database. We can leverage the following community resources to bootstrap and enrich the application:

### 1. `EDCD/FDevIDs` (Essential — Static Reference Data)
* **Source:** [`https://github.com/EDCD/FDevIDs`](https://github.com/EDCD/FDevIDs) (`commodity.csv` and `rare_commodity.csv`).
* **Purpose:** EDDN `commodity/3` only transmits internal lowercase symbolic names (e.g., `fruitandvegetables`, `imperialslaves`, `lowtemperaturediamond`) without display names or categories.
* **Usage:** Seed a `commodities` reference table on startup from `commodity.csv` (mapping `symbol.toLowerCase()` $\rightarrow$ `{ fdev_id, symbol, display_name, category, is_rare }`). This gives clean human-readable names (`"Fruit and Vegetables"`, `"Low Temperature Diamonds"`) and category filtering (`"Metals"`, `"Minerals"`, `"Foods"`) in Discord autocomplete.

### 2. EDSM (Elite Dangerous Star Map) API & Nightly Dumps
* **Source:**
  * REST API: `https://www.edsm.net/api-v1/system?systemName=<name>&showCoordinates=1&showId=1&showInformation=1`
  * Nightly Station Dump: `https://www.edsm.net/dump/stations.json.gz` (~45 MB compressed)
  * Nightly Populated Systems Dump: `https://www.edsm.net/dump/systemsPopulated.json.gz` (~523 MB compressed)
* **Purpose:**
  * If a `commodity/3` message arrives for a system whose `[x, y, z]` coordinates or station pad sizes are not yet in our database (because no `Docked` or `FSDJump` event was captured first), a lightweight background resolver can query EDSM's `/api-v1/system` (or Spansh's API) with rate-limiting to backfill `x, y, z` coordinates and station pad sizes immediately.

### 3. Spansh Data Dumps & API (`spansh.co.uk`)
* **Source:**
  * `https://downloads.spansh.co.uk/systems_1day.json.gz` (~2.7 MB — systems updated in the last 24h)
  * `https://downloads.spansh.co.uk/galaxy_1day.json.gz` (~1.1 GB — full system/station/market data updated in the last 24h)
  * `https://downloads.spansh.co.uk/galaxy_populated.json.gz` (~4.5 GB — all populated systems, stations, factions, and markets)
* **Purpose:** Optional cold-start seeding script (`bun run scripts/seed-spansh.ts`) if we want the database pre-populated with recent galaxy/Bubble station metadata on day 1 rather than waiting a few hours for EDDN traffic to populate active markets.

### 4. Ardent Industry API (`api.ardent-industry.com`)
* **Source:** Open REST API built on EDDN data (`https://api.ardent-industry.com`).
* **Purpose:** Useful as a reference benchmark or optional fallback for cold-start market queries.
