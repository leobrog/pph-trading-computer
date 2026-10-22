# PPH Trading Computer — Documentation Index

Welcome to the technical documentation for the **People's Party of Heverty (PPH) Trading Computer for Elite Dangerous**.

## Proposal
* [Project Proposal](./project_proposal.md)

## Research Documents
1. [01 — EDDN Protocol, Schemas & Elite Dangerous Third-Party Ecosystem](./research/01-eddn-and-third-party-tools.md)
   * Analysis of `tcp://eddn.edcd.io:9500`, `commodity/3`, and `journal/1` (`Docked`, `FSDJump`, `Location`, `CarrierJump`).
   * Why `commodity/3` must be paired with `journal/1` (3D `StarPos` coordinates, `LandingPads`, `DistFromStarLS`, and BGS `StationFaction` / `Factions`).
   * Data hygiene: filtering Legacy 3.8 clients, rejecting stale EDDiscovery log replays, and handling 64-bit `MarketID`/`SystemAddress`.
   * Leveraging `EDCD/FDevIDs` (`commodity.csv`), EDSM API/dumps, and Spansh dumps.
2. [02 — PostgreSQL Schema Design, 3D Spatial Indexing & TTL Strategy](./research/02-database-and-ttl-strategy.md)
   * Complete relational schema (`systems`, `stations`, `commodities`, `market_listings`, `factions`, `system_factions`) targeting PostgreSQL 18 (`postgres:18-alpine`).
   * Fast 3D Euclidean distance queries in Light Years using PostgreSQL's built-in `cube` extension (`GiST` index) and `pg_trgm` for instant Discord autocomplete.
   * High-throughput batch upsert patterns using `UNNEST` and timestamp guards.
   * Tiered Time-To-Live (TTL) expiration and periodic cleanup design.
3. [03 — Bun Tech Stack, ZeroMQ Listener & Docker Compose Orchestration](./research/03-tech-stack-and-docker-compose.md)
   * Native `Bun.sql` PostgreSQL usage.
   * Live-tested pure-Bun ZMTP 3.0 `SUB` socket (`Bun.connect` + `node:zlib`) vs. native `zeromq` N-API addon in Docker.
   * Extensible Discord bot command plugin architecture (`Bun.Glob` auto-discovery).
   * Multi-container `docker-compose.yml` architecture (`db`, `listener`, `bot`).

## Phased Implementation Plan
* [Implementation Plan Overview](./plan/overview.md)
* [Phase 1: Infrastructure, Docker Compose & Database Layer](./plan/phase-1-infrastructure-and-database.md)
* [Phase 2: EDDN ZeroMQ Listener & TTL Cleanup Service](./plan/phase-2-eddn-listener-and-ttl.md)
* [Phase 3: Extensible Discord Bot Framework](./plan/phase-3-discord-bot-framework.md)
* [Phase 4: Trading & BGS Undermining Commands](./plan/phase-4-trading-and-bgs-commands.md)
