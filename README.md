# PPH Trading Computer for Elite Dangerous

Real-time **Elite Dangerous** market intelligence and Background Simulation (BGS) operations computer built for the **People's Party of Heverty (PPH)**.

## Architecture

The application is orchestrated via `docker-compose.yml` across three isolated services on the internal `pph-net` bridge network:
1. **`db` (`postgres:18-alpine`)**: PostgreSQL 18 with `cube` (3D Euclidean spatial indexing in Light Years) and `pg_trgm` (instant fuzzy/prefix autocomplete). Not exposed to the host network.
2. **`listener` (`src/listener/index.ts`)**: Pure-Bun ZMTP 3.0 `SUB` client streaming live telemetry from `tcp://eddn.edcd.io:9500` (`commodity/3` and `journal/1`: `Docked`, `FSDJump`, `Location`, `CarrierJump`), backed by an EDSM coordinate/population resolver and a periodic Time-To-Live (TTL) cleanup worker.
3. **`bot` (`src/bot/index.ts`)**: Extensible `discord.js` v14 slash command bot with `Bun.Glob` command auto-discovery, context-aware `pg_trgm` autocomplete, and interactive button pagination.

For detailed architectural research and implementation docs, see [docs/README.md](./docs/README.md).

---

## Quick Start (Docker Compose)

1. Copy `.env.example` to `.env` and fill in your Discord application credentials (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID` for instant guild command registration):
   ```bash
   cp .env.example .env
   ```
2. Start all services (`db`, `listener`, and `bot`):
   ```bash
   docker compose up -d --build
   ```
3. View live EDDN ingestion or bot logs:
   ```bash
   docker compose logs -f listener
   docker compose logs -f bot
   ```

---

## Slash Commands

| Command | Category | Description |
| :--- | :--- | :--- |
| `/trade-route` | **Trading** | Finds the most profitable commodity trade routes between two systems/stations or within a 3D jump radius (`max_distance_ly`). |
| `/internal-route` | **Trading** | Finds the most profitable internal (in-system) commodity trade routes between markets within the same star system. |
| `/commodity-buy` | **Trading** | Finds the cheapest recorded buying prices and supply stock for a commodity (galactic or near a reference system). |
| `/commodity-sell` | **Trading** | Finds the highest recorded selling prices and demand for a commodity (galactic or near a reference system). |
| `/market-listings` | **Trading** | Displays all recorded commodity buy/sell prices, supply stock, and demand for a specific market/station. |
| `/undermine-trade` | **BGS** | Finds loss trade routes (`sell_price < buy_price`) targeting a system, station, or minor faction to inflict negative BGS influence (`budget_loss` or `heavy_loss` strategies). Automatically excludes Fleet Carriers as targets. |
| `/system-report` | **BGS** | Displays a full BGS intelligence report for a star system (population, security, minor faction influence rankings, active/pending/recovering states, tactical alerts, and stations). |
| `/faction-status` | **BGS** | Displays a Minor Faction's multi-system BGS overview across all inhabited systems (influence %, rival margins, active/pending/recovering states, and controlled assets). |
| `/faction-markets` | **BGS** | Lists all known stations controlled by a Minor Faction (defaults to *People's Party of Heverty*) with BGS state, influence %, landing pad size, Black Market availability, and market freshness. |
| `/db-status` | **Utility** | Displays live EDDN telemetry stats, database record counts, and configured TTL policies. |
| `/help` | **Utility** | Dynamically lists all registered slash commands grouped by category. |

---

## Adding a New Bot Command

Commands are auto-discovered at startup via `Bun.Glob("**/*.command.ts")`:
1. Create a new file under `src/bot/commands/<category>/<name>.command.ts`.
2. Default-export a `BotCommand` object (`category`, `data`, `execute`, and optional `autocomplete: createAutocomplete({...})`).
3. Restart `bot` or run `bun run deploy-commands`.

---

## Development & Testing

```bash
# Typecheck the codebase
bun check

# Run unit & PostgreSQL integration tests inside the running container
docker compose exec bot bun test --check
```
