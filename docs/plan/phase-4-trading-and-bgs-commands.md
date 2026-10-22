# Phase 4: Trading & BGS Undermining Commands

## Objective
Implement the core Elite Dangerous market and BGS commands using `Bun.sql` spatial and relational queries, covering all examples from the project proposal plus BGS-focused enhancements for the **People's Party of Heverty (PPH)**.

---

## 1. Command Specifications

### Command 1: `/trade-route` (`src/bot/commands/trade/route.command.ts`)
> *Proposal requirement: "A command that returns all the most profitable trades between 2 systems, stations, etc."*

Supports both **Point-to-Point** (System A / Station A $\rightarrow$ System B / Station B) and **Radius Search** (Start at System A / Station A $\rightarrow$ best destination within `max_distance_ly` Light Years, or vice versa!).

* **Slash Command Options:**
  * `from_system` (`string`, autocomplete, required): Origin star system (e.g., `Heverty`).
  * `from_station` (`string`, autocomplete, optional): Specific origin station in `from_system`.
  * `to_system` (`string`, autocomplete, optional): Specific destination star system. (If omitted, searches all systems within `max_distance_ly` of `from_system`!)
  * `to_station` (`string`, autocomplete, optional): Specific destination station in `to_system`.
  * `max_distance_ly` (`number`, optional, default: `50`): Max jump distance in Light Years when `to_system` is not locked.
  * `min_pad` (`string` choice: `Large` / `Medium` / `Any`, default: `Large`): Minimum landing pad size required on both ends.
  * `min_stock` (`integer`, optional, default: `500`): Minimum supply units at buying station.
  * `min_demand` (`integer`, optional, default: `0`): Minimum demand units at selling station.
  * `max_ls` (`integer`, optional, default: `5000`): Maximum station distance from arrival star in light-seconds.
  * `include_carriers` (`boolean`, optional, default: `false`): Whether to include Fleet Carriers (with `carrier_docking_access = 'all'`).
  * `cargo_capacity` (`integer`, optional, default: `784`): Optional ship cargo capacity (in tons) to display total profit per trip alongside profit/ton.

* **SQL Query Logic:**
  * Joins `market_listings AS buy` (at origin system/station/radius where `buy.buy_price > 0 AND buy.stock >= $min_stock`) with `market_listings AS sell` (at destination system/station/radius where `sell.sell_price > buy.buy_price` and `sell.commodity_id = buy.commodity_id`).
  * Computes:
    * `profit_per_ton = sell.sell_price - buy.buy_price`
    * `distance_ly = cube(ARRAY[s_from.x, s_from.y, s_from.z]) <-> cube(ARRAY[s_to.x, s_to.y, s_to.z])`
  * Orders by `profit_per_ton DESC`.

---

### Command 2: `/undermine-trade` (`src/bot/commands/bgs/undermine.command.ts`)
> *Proposal requirement: "A command that finds trade routes that result in loss trades so players can use those to undermine a faction's economy."*

Specifically designed for BGS operations where commanders want to buy high at a nearby source station and **sell at a loss (`sell_price < buy_price`)** to a target station controlled by an enemy faction (inflicting negative BGS influence on the station's controlling faction).

* **Slash Command Options:**
  * `target_system` (`string`, autocomplete, optional): System containing the station(s) to undermine.
  * `target_station` (`string`, autocomplete, optional): Specific target station to dump commodities into.
  * `target_faction` (`string`, autocomplete, optional): Target controlling minor faction to undermine (can be used alone or combined with `target_system` to automatically target only stations owned by that faction!).
  * `max_distance_ly` (`number`, optional, default: `40`): Max jump distance from source supply station to the target station.
  * `strategy` (`string` choice, default: `budget_loss`):
    * `budget_loss` ("Minimize Credit Loss / Cheap Dumping"): Finds routes where `sell_price < buy_price` with the **smallest loss per ton** (e.g., `-5 CR/t` to `-500 CR/t`) and high supply, so commanders can dump thousands of tons without burning credits.
    * `heavy_loss` ("Maximize Credit Loss / Deep Deficit"): Finds routes with the **largest negative credit loss per ton** (`sell_price - buy_price ASC`) for maximum credit-loss impact per transaction.
  * `max_loss_per_ton` (`integer`, optional): Cap on how many credits per ton the commander is willing to lose.
  * `min_stock` (`integer`, optional, default: `1000`): Minimum supply at the source station.
  * `min_pad` (`string` choice: `Large` / `Medium` / `Any`, default: `Large`).
  * `max_ls` (`integer`, optional, default: `5000`).

* **BGS Safeguards Built Into Query:**
  * **Automatically excludes Fleet Carriers (`is_fleet_carrier = false`)** on the target side because Fleet Carriers have no minor faction BGS influence.
  * Displays the target station's **Controlling Faction** and **Faction State** prominently in the Discord embed so commanders never accidentally dump loss trades into a station controlled by an allied faction or PPH itself!

---

### Command 3: `/commodity-buy` (`src/bot/commands/trade/buy.command.ts`)
> *Proposal requirement: "A command that finds the cheapest recorded buying price for a commodity and its location"*

* **Slash Command Options:**
  * `commodity` (`string`, autocomplete, required): Commodity to buy (e.g., `Gold`, `Tritium`, `Agronomic Treatment`).
  * `near_system` (`string`, autocomplete, optional): Reference star system (if provided, shows distance in Ly and optionally filters by `max_distance_ly`).
  * `max_distance_ly` (`number`, optional): Only search within $N$ Light Years of `near_system`.
  * `min_stock` (`integer`, optional, default: `100`): Minimum available stock (`stock >= min_stock`).
  * `min_pad` (`string` choice: `Large` / `Medium` / `Any`, default: `Any`).
  * `include_carriers` (`boolean`, optional, default: `true`).
  * `sort_by` (`string` choice: `price` [Cheapest First] / `distance` [Closest First], default: `price`).

* **SQL Query Logic:**
  * Queries `market_listings ml JOIN stations st ON ... JOIN systems sys ON ...` where `ml.commodity_id = $id AND ml.buy_price > 0 AND ml.stock >= $min_stock`.
  * Orders by `ml.buy_price ASC, distance_ly ASC` (or `distance_ly ASC, ml.buy_price ASC`).
  * Displays `Buy Price`, `% below Galactic Average (mean_price)`, `Stock`, `Pad Size`, `Dist from Star (ls)`, `Distance (Ly)`, `Controlling Faction`, and `Updated <relative time>`.

---

### Command 4: `/commodity-sell` (`src/bot/commands/trade/sell.command.ts`)
> *Proposal requirement: "A command that finds the most expensive selling price for a commodity and its location"*

* **Slash Command Options:**
  * `commodity` (`string`, autocomplete, required): Commodity to sell (e.g., `Platinum`, `Low Temperature Diamonds`).
  * `near_system` (`string`, autocomplete, optional): Reference star system for distance calculation / radius filtering.
  * `max_distance_ly` (`number`, optional): Only search within $N$ Light Years of `near_system`.
  * `min_demand` (`integer`, optional, default: `1`): Minimum demand units (`demand >= min_demand`).
  * `min_pad` (`string` choice: `Large` / `Medium` / `Any`, default: `Any`).
  * `include_carriers` (`boolean`, optional, default: `true`).
  * `sort_by` (`string` choice: `price` [Highest Sell Price First] / `distance` [Closest First], default: `price`).

* **SQL Query Logic:**
  * Queries `market_listings ml` where `ml.commodity_id = $id AND ml.sell_price > 0 AND ml.demand >= $min_demand`.
  * Orders by `ml.sell_price DESC, distance_ly ASC`.
  * Also highlights when `demandBracket >= 2` (or when `demand` is high enough that bulk tax won't reduce the sell price!).

---

### Command 5: `/faction-markets` & `/db-status` (BGS & Operational Utilities)
* `/faction-markets`: Lists all known stations controlled by a given Minor Faction (e.g. `People's Party of Heverty` or a rival faction), showing each station's system, current BGS state, influence %, landing pad size, whether it has a Black Market, and when its market was last updated on EDDN.
* `/db-status`: Shows total tracked systems, stations, active market listings, EDDN listener ingestion rate (msgs/min), and TTL configuration.

---

## 2. Testing Strategy (`tests/`)
* **Unit Tests (`bun test`):**
  * `normalizer.test.ts`: Tests FDev string cleaning, pad size inference from `LandingPads` and `StationType`, and timestamp validation.
  * `zmtp.test.ts`: Tests ZMTP 3.0 handshake and multi-chunk frame reassembly with compressed zlib payloads.
  * `registry.test.ts`: Verifies automatic discovery of all `*.command.ts` files and validates their SlashCommand schemas.
* **Database Query Integration Tests:**
  * Seeds a test fixture with `Heverty` (`Woodroffe Gateway`) and neighboring systems (`Malgar`, `Ngane`) to verify `/trade-route`, `/undermine-trade`, `/commodity-buy`, `/commodity-sell`, and TTL cleanup queries.
