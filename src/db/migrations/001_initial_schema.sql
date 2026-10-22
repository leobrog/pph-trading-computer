-- =============================================================================
-- PPH Trading Computer — Initial PostgreSQL 18 Schema
-- =============================================================================

-- Enable 3D Euclidean spatial indexing (Light Years) and trigram fuzzy search
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- 1. Star Systems
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS systems (
  id BIGSERIAL PRIMARY KEY,
  system_address BIGINT UNIQUE,
  name TEXT NOT NULL UNIQUE,
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  z DOUBLE PRECISION,
  population BIGINT,
  is_under_colonisation BOOLEAN NOT NULL DEFAULT FALSE,
  allegiance TEXT,
  government TEXT,
  primary_economy TEXT,
  security TEXT,
  controlling_faction TEXT,
  controlling_power TEXT,
  powerplay_state TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. Stations, Starports, Outposts, Settlements, Fleet Carriers & Colonisation Ships
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
  market_id BIGINT PRIMARY KEY,
  system_id BIGINT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  station_type TEXT,
  is_fleet_carrier BOOLEAN NOT NULL DEFAULT FALSE,
  is_colonisation_vessel BOOLEAN NOT NULL DEFAULT FALSE,
  max_landing_pad CHAR(1) CHECK (max_landing_pad IN ('S', 'M', 'L') OR max_landing_pad IS NULL),
  pad_small SMALLINT,
  pad_medium SMALLINT,
  pad_large SMALLINT,
  distance_to_arrival_ls DOUBLE PRECISION,
  controlling_faction TEXT,
  controlling_faction_state TEXT,
  government TEXT,
  primary_economy TEXT,
  economies JSONB,
  has_blackmarket BOOLEAN NOT NULL DEFAULT FALSE,
  services TEXT[],
  prohibited_commodities TEXT[],
  carrier_docking_access TEXT,
  meta_updated_at TIMESTAMPTZ,
  market_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 3. Commodities Reference Catalog (Seeded from EDCD/FDevIDs)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commodities (
  id SERIAL PRIMARY KEY,
  fdev_id BIGINT UNIQUE,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  is_rare BOOLEAN NOT NULL DEFAULT FALSE
);

-- -----------------------------------------------------------------------------
-- 4. Market Listings (Live EDDN commodity/3 Snapshots)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_listings (
  market_id BIGINT NOT NULL REFERENCES stations(market_id) ON DELETE CASCADE,
  commodity_id INTEGER NOT NULL REFERENCES commodities(id) ON DELETE CASCADE,
  mean_price INTEGER NOT NULL DEFAULT 0,
  buy_price INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  stock_bracket SMALLINT,
  sell_price INTEGER NOT NULL DEFAULT 0,
  demand INTEGER NOT NULL DEFAULT 0,
  demand_bracket SMALLINT,
  status_flags TEXT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market_id, commodity_id)
);

-- -----------------------------------------------------------------------------
-- 5. Minor Factions & System Faction Presence (BGS Tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS factions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  allegiance TEXT,
  government TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_factions (
  system_id BIGINT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  faction_id INTEGER NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
  influence DOUBLE PRECISION,
  faction_state TEXT,
  happiness TEXT,
  active_states JSONB,
  pending_states JSONB,
  recovering_states JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (system_id, faction_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- 3D Spatial GiST index on known (x, y, z) coordinates for fast radius & KNN queries
CREATE INDEX IF NOT EXISTS idx_systems_coords_gist
  ON systems USING gist (cube(ARRAY[x, y, z]))
  WHERE x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_systems_name_lower
  ON systems (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_systems_updated_at
  ON systems (updated_at);

-- Station lookup & BGS filtering indexes
CREATE INDEX IF NOT EXISTS idx_stations_system_id
  ON stations (system_id);

CREATE INDEX IF NOT EXISTS idx_stations_controlling_faction
  ON stations (controlling_faction)
  WHERE controlling_faction IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stations_updated_at
  ON stations (updated_at);

-- Commodity market price & TTL indexes
CREATE INDEX IF NOT EXISTS idx_market_buy_price
  ON market_listings (commodity_id, buy_price ASC)
  WHERE buy_price > 0 AND stock > 0;

CREATE INDEX IF NOT EXISTS idx_market_sell_price
  ON market_listings (commodity_id, sell_price DESC)
  WHERE sell_price > 0;

CREATE INDEX IF NOT EXISTS idx_market_updated_at
  ON market_listings (updated_at);

-- System factions BGS & TTL indexes
CREATE INDEX IF NOT EXISTS idx_system_factions_faction_id
  ON system_factions (faction_id);

CREATE INDEX IF NOT EXISTS idx_system_factions_updated_at
  ON system_factions (updated_at);

-- Trigram GIN indexes for instant Discord slash command autocomplete
CREATE INDEX IF NOT EXISTS idx_systems_name_trgm
  ON systems USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_stations_name_trgm
  ON stations USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_commodities_name_trgm
  ON commodities USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_factions_name_trgm
  ON factions USING gin (name gin_trgm_ops);
