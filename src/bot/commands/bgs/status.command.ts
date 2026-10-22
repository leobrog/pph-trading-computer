import { SlashCommandBuilder } from "discord.js";
import { env } from "../../../config/env.ts";
import { sql } from "../../../db/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatNumber,
  formatRelativeTimestamp,
  PPH_COLORS,
} from "../../ui/embeds.ts";

interface DbStatusSummary {
  total_systems: number;
  systems_with_coords: number;
  colonising_systems: number;
  permanent_stations: number;
  fleet_carriers: number;
  colonisation_vessels: number;
  total_commodities: number;
  total_listings: number;
  total_factions: number;
  total_system_factions: number;
  markets_last_15m: number;
  latest_market_at: Date | string | null;
}

export async function getDatabaseStatusSummary(): Promise<DbStatusSummary> {
  const rows = await sql<DbStatusSummary[]>`
    SELECT
      (SELECT COUNT(*)::int FROM systems) AS total_systems,
      (SELECT COUNT(*)::int FROM systems WHERE x IS NOT NULL) AS systems_with_coords,
      (SELECT COUNT(*)::int FROM systems WHERE is_under_colonisation = true) AS colonising_systems,
      (SELECT COUNT(*)::int FROM stations WHERE is_fleet_carrier = false AND is_colonisation_vessel = false) AS permanent_stations,
      (SELECT COUNT(*)::int FROM stations WHERE is_fleet_carrier = true) AS fleet_carriers,
      (SELECT COUNT(*)::int FROM stations WHERE is_colonisation_vessel = true) AS colonisation_vessels,
      (SELECT COUNT(*)::int FROM commodities) AS total_commodities,
      (SELECT COUNT(*)::int FROM market_listings) AS total_listings,
      (SELECT COUNT(*)::int FROM factions) AS total_factions,
      (SELECT COUNT(*)::int FROM system_factions) AS total_system_factions,
      (SELECT COUNT(*)::int FROM stations WHERE market_updated_at >= NOW() - INTERVAL '15 minutes') AS markets_last_15m,
      (SELECT MAX(updated_at) FROM market_listings) AS latest_market_at
  `;
  return rows[0]!;
}

const statusCommand: BotCommand = {
  category: "Utility",
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName("db-status")
    .setDescription(
      "Displays live EDDN telemetry stats, database record counts, and TTL policies.",
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const stats = await getDatabaseStatusSummary();
    const latestUpdateText = stats.latest_market_at
      ? formatRelativeTimestamp(stats.latest_market_at)
      : "No markets recorded yet";

    const embed = createPphEmbed({
      title: "📡 PPH Trading Computer — Telemetry & Database Status",
      description:
        `Connected to live EDDN relay (\`${env.eddnZmqUrl}\`).\n` +
        `**Latest Market Snapshot:** ${latestUpdateText} (${formatNumber(stats.markets_last_15m)} stations updated in last 15m)`,
      color: PPH_COLORS.INFO,
    }).addFields(
      {
        name: "🌌 Star Systems",
        value:
          `• **Populated / Tracked:** ${formatNumber(stats.total_systems)}\n` +
          `• **3D Coords Indexed:** ${formatNumber(stats.systems_with_coords)}\n` +
          `• **Active Colonisation:** ${formatNumber(stats.colonising_systems)}`,
        inline: true,
      },
      {
        name: "🎡 Stations & Markets",
        value:
          `• **Permanent Ports:** ${formatNumber(stats.permanent_stations)}\n` +
          `• **Fleet Carriers:** ${formatNumber(stats.fleet_carriers)}\n` +
          `• **Colonisation Ships:** ${formatNumber(stats.colonisation_vessels)}`,
        inline: true,
      },
      {
        name: "📦 Market & BGS Data",
        value:
          `• **Active Listings:** ${formatNumber(stats.total_listings)}\n` +
          `• **Commodity Catalog:** ${formatNumber(stats.total_commodities)}\n` +
          `• **Minor Factions:** ${formatNumber(stats.total_factions)} (${formatNumber(stats.total_system_factions)} presences)`,
        inline: true,
      },
      {
        name: "⏳ Configured Time-To-Live (TTL) Policies",
        value:
          `• **Station Markets:** \`${env.ttl.stationMarketHours}h\` (${(env.ttl.stationMarketHours / 24).toFixed(1)}d)\n` +
          `• **Fleet Carrier Markets:** \`${env.ttl.carrierMarketHours}h\` (${(env.ttl.carrierMarketHours / 24).toFixed(1)}d)\n` +
          `• **Transient Carriers / Colonisation Ships:** \`${env.ttl.transientStationDays}d\`\n` +
          `• **System Faction BGS States:** \`${env.ttl.factionStateDays}d\`\n` +
          `• **Cleanup Interval:** Every \`${env.ttl.cleanupIntervalMinutes}m\``,
        inline: false,
      },
    );

    await interaction.editReply({ embeds: [embed] });
  },
};

export default statusCommand;
