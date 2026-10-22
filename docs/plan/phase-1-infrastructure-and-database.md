# Phase 1: Infrastructure, Docker Compose & Database Layer

## Objective
Set up the containerized environment (`docker-compose.yml` + `Dockerfile`), the PostgreSQL 18 (`postgres:18-alpine`) database schema with 3D spatial (`cube`) and trigram (`pg_trgm`) extensions, the `Bun.sql` database client, migration runner, and the static commodity seeder powered by `EDCD/FDevIDs`.

---

## 1. Docker & Orchestration (`docker-compose.yml` & `Dockerfile`)

### `Dockerfile`
A single lightweight `oven/bun:1-alpine` image shared by both the `listener` and `bot` services (overriding `CMD` per service in `docker-compose.yml`):

```dockerfile
FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies with frozen lockfile
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

CMD ["bun", "run", "src/listener/index.ts"]
```

### `docker-compose.yml`
PostgreSQL (`postgres:18-alpine`, latest stable major version) has **no `ports:` mapping**, ensuring it is never exposed to the host or local network—only containers attached to the internal `pph-net` network (`listener` and `bot`) can reach `db:5432`. Note that starting in PostgreSQL 18+, the volume mount path is `/var/lib/postgresql` (which stores versioned data under `/var/lib/postgresql/18/docker`).

```yaml
services:
  db:
    image: postgres:18-alpine
    container_name: pph-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-pph}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-pph_secret}
      POSTGRES_DB: ${POSTGRES_DB:-pph_trading}
    volumes:
      - pgdata:/var/lib/postgresql
    networks:
      - pph-net
    command:
      - "postgres"
      - "-c"
      - "shared_buffers=256MB"
      - "-c"
      - "work_mem=16MB"
      - "-c"
      - "synchronous_commit=off"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-pph} -d ${POSTGRES_DB:-pph_trading}"]
      interval: 5s
      timeout: 5s
      retries: 5

  listener:
    build: .
    container_name: pph-eddn-listener
    restart: unless-stopped
    command: ["bun", "run", "src/listener/index.ts"]
    env_file: .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-pph}:${POSTGRES_PASSWORD:-pph_secret}@db:5432/${POSTGRES_DB:-pph_trading}
    networks:
      - pph-net
    depends_on:
      db:
        condition: service_healthy

  bot:
    build: .
    container_name: pph-discord-bot
    restart: unless-stopped
    command: ["bun", "run", "src/bot/index.ts"]
    env_file: .env
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-pph}:${POSTGRES_PASSWORD:-pph_secret}@db:5432/${POSTGRES_DB:-pph_trading}
    networks:
      - pph-net
    depends_on:
      db:
        condition: service_healthy

networks:
  pph-net:
    driver: bridge

volumes:
  pgdata:
```

---

## 2. Database Schema (`src/db/migrations/001_initial_schema.sql`)

### Extensions
* `cube`: Enables 3D spatial indexing (`cube(ARRAY[x, y, z])`) and fast 3D distance operator `<->` in Light Years.
* `pg_trgm`: Enables fast fuzzy/prefix `ILIKE` search for Discord slash command autocomplete.

### Core Tables
1. **`systems`**:
   * `id BIGSERIAL PRIMARY KEY`
   * `system_address BIGINT UNIQUE` (nullable if first created via `commodity/3`)
   * `name TEXT NOT NULL UNIQUE`
   * `x DOUBLE PRECISION`, `y DOUBLE PRECISION`, `z DOUBLE PRECISION`
   * `population BIGINT`
   * `is_under_colonisation BOOLEAN NOT NULL DEFAULT FALSE`
   * `allegiance TEXT`, `government TEXT`, `primary_economy TEXT`, `security TEXT`
   * `controlling_faction TEXT`, `controlling_power TEXT`, `powerplay_state TEXT`
   * `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
2. **`stations`**:
   * `market_id BIGINT PRIMARY KEY`
   * `system_id BIGINT NOT NULL REFERENCES systems(id) ON DELETE CASCADE`
   * `name TEXT NOT NULL`
   * `station_type TEXT`
   * `is_fleet_carrier BOOLEAN NOT NULL DEFAULT FALSE`
   * `is_colonisation_vessel BOOLEAN NOT NULL DEFAULT FALSE`
   * `max_landing_pad CHAR(1)` (`'S'`, `'M'`, `'L'`, or `NULL`)
   * `pad_small SMALLINT`, `pad_medium SMALLINT`, `pad_large SMALLINT`
   * `distance_to_arrival_ls DOUBLE PRECISION`
   * `controlling_faction TEXT`, `controlling_faction_state TEXT`
   * `government TEXT`, `primary_economy TEXT`, `economies JSONB`
   * `has_blackmarket BOOLEAN NOT NULL DEFAULT FALSE`
   * `services TEXT[]`, `prohibited_commodities TEXT[]`
   * `carrier_docking_access TEXT`
   * `meta_updated_at TIMESTAMPTZ`, `market_updated_at TIMESTAMPTZ`
   * `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
3. **`commodities`**:
   * `id SERIAL PRIMARY KEY`
   * `fdev_id BIGINT UNIQUE`
   * `symbol TEXT NOT NULL UNIQUE` (lowercase EDDN symbolic name, e.g., `advancedcatalysers`)
   * `name TEXT NOT NULL` (display name, e.g., `Advanced Catalysers`)
   * `category TEXT NOT NULL` (e.g., `Technology`, `Metals`)
   * `is_rare BOOLEAN NOT NULL DEFAULT FALSE`
4. **`market_listings`**:
   * `market_id BIGINT NOT NULL REFERENCES stations(market_id) ON DELETE CASCADE`
   * `commodity_id INTEGER NOT NULL REFERENCES commodities(id) ON DELETE CASCADE`
   * `mean_price INTEGER NOT NULL DEFAULT 0`
   * `buy_price INTEGER NOT NULL DEFAULT 0`
   * `stock INTEGER NOT NULL DEFAULT 0`
   * `stock_bracket SMALLINT`
   * `sell_price INTEGER NOT NULL DEFAULT 0`
   * `demand INTEGER NOT NULL DEFAULT 0`
   * `demand_bracket SMALLINT`
   * `status_flags TEXT[]`
   * `updated_at TIMESTAMPTZ NOT NULL`
   * `PRIMARY KEY (market_id, commodity_id)`
5. **`factions`** & **`system_factions`**:
   * Tracks minor factions and their per-system `influence`, `faction_state`, `happiness`, and `active_states`/`pending_states`/`recovering_states` from `FSDJump`/`Location` events.

### Key Indexes
* `idx_systems_coords_gist`: `USING gist (cube(ARRAY[x, y, z])) WHERE x IS NOT NULL`
* `idx_stations_system_id`: `ON stations(system_id)`
* `idx_stations_controlling_faction`: `ON stations(controlling_faction) WHERE controlling_faction IS NOT NULL`
* `idx_market_buy_price`: `ON market_listings(commodity_id, buy_price ASC) WHERE buy_price > 0 AND stock > 0`
* `idx_market_sell_price`: `ON market_listings(commodity_id, sell_price DESC) WHERE sell_price > 0`
* `idx_market_updated_at`: `ON market_listings(updated_at)` (for fast TTL cleanup)
* GIN `gin_trgm_ops` indexes on `systems(name)`, `stations(name)`, `commodities(name)`, `factions(name)`.

---

## 3. Commodity Catalog Seeder (`scripts/seed-commodities.ts`)

1. Downloads (or reads bundled fallback copy of) `commodity.csv` and `rare_commodity.csv` from `https://raw.githubusercontent.com/EDCD/FDevIDs/master/`.
2. Normalizes `symbol` to lowercase (`symbol.trim().toLowerCase()`) to match EDDN `commodity/3` `name` values.
3. Upserts into `commodities` table via `Bun.sql`.
4. Also supports dynamic auto-insertion in the listener if Frontier introduces a brand-new commodity in a game patch before `FDevIDs` is updated.

---

## 4. Verification Criteria for Phase 1
* `docker compose up -d db` starts PostgreSQL 18 (`postgres:18-alpine`) on the internal `pph-net` bridge network with no host port published, and passes its healthcheck.
* Running migrations and seeding via container (`docker compose run --rm listener bun run scripts/migrate.ts` and `docker compose run --rm listener bun run scripts/seed-commodities.ts`, or automatically on `listener` boot) applies `001_initial_schema.sql` cleanly and populates ~450 standard and rare commodities into `commodities`.
