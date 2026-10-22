import { SlashCommandBuilder } from "discord.js";
import {
  getSystemBgsReport,
  type SystemFactionBgsRow,
  type SystemStationBgsRow,
} from "../../../db/queries/bgs.ts";
import { autocompleteSystem, createAutocomplete } from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatDistanceLs,
  formatInfluenceBar,
  formatNumber,
  formatPadBadge,
  formatRelativeTimestamp,
  formatStationTypeBadge,
  PPH_COLORS,
} from "../../ui/embeds.ts";

function formatFactionField(
  faction: SystemFactionBgsRow,
  index: number,
): { name: string; value: string; inline: boolean } {
  const rankBadge = faction.is_controlling ? "👑" : `#${index + 1}`;
  const ctrlSuffix = faction.is_controlling ? " [Controlling]" : "";

  const govStr = faction.government ?? "Unknown Gov";
  const allegStr = faction.allegiance ? ` (${faction.allegiance})` : "";
  const originTag = faction.is_native ? " • 🏠 Native" : " • 🌐 Foreign";
  const happyStr = faction.happiness ? ` • 😊 ${faction.happiness}` : "";

  const primaryState = faction.faction_state || "None";
  const extraActive = faction.active_states.filter(
    (s) => s.toLowerCase() !== primaryState.toLowerCase(),
  );

  let stateLines = `📊 **State:** \`${primaryState}\``;
  if (extraActive.length > 0) {
    stateLines += ` • **Active:** ${extraActive.map((s) => `\`${s}\``).join(", ")}`;
  }
  if (faction.pending_states.length > 0) {
    stateLines += `\n⏳ **Pending:** ${faction.pending_states.map((s) => `\`${s}\``).join(", ")}`;
  }
  if (faction.recovering_states.length > 0) {
    stateLines += `\n🩹 **Recovering:** ${faction.recovering_states.map((s) => `\`${s}\``).join(", ")}`;
  }

  return {
    name: `${rankBadge} ${faction.name}${ctrlSuffix}`,
    value:
      `${formatInfluenceBar(faction.influence)} • 🏛️ ${govStr}${allegStr}${originTag}${happyStr}\n` +
      `${stateLines}\n` +
      `🎡 **Stations:** \`${faction.controlled_stations_count}\` • 🕒 ${formatRelativeTimestamp(faction.updated_at)}`,
    inline: false,
  };
}

function formatStationLine(st: SystemStationBgsRow): string {
  const badge = formatStationTypeBadge({
    stationType: st.station_type,
    isColonisationVessel: st.is_colonisation_vessel,
  });
  const owner = st.controlling_faction ? `🚩 *${st.controlling_faction}*` : "🚩 *Uncontrolled*";
  const bm = st.has_blackmarket ? " • 💀 BM" : "";
  const marketAge = st.market_updated_at
    ? ` • 🛒 ${formatRelativeTimestamp(st.market_updated_at)}`
    : "";

  return `• **${st.name}** ${formatPadBadge(st.max_landing_pad)} • ${badge} • ${formatDistanceLs(st.distance_to_arrival_ls)}\n  └ ${owner}${bm}${marketAge}`;
}

const systemReportCommand: BotCommand = {
  category: "BGS",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("system-report")
    .setDescription(
      "Displays a full BGS report for a star system (factions, influence %, states, and stations).",
    )
    .addStringOption((opt) =>
      opt
        .setName("system")
        .setDescription("Star system to inspect (default: Heverty)")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  autocomplete: createAutocomplete({
    system: autocompleteSystem,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const systemQuery = interaction.options.getString("system")?.trim() || "Heverty";
    const report = await getSystemBgsReport(systemQuery);

    if (!report.system) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Star System Not Found",
        description: `Could not find star system **${systemQuery}** in the database or EDSM.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    const sys = report.system;
    const coordsText =
      sys.x !== null && sys.y !== null && sys.z !== null
        ? `\`(${sys.x.toFixed(2)}, ${sys.y.toFixed(2)}, ${sys.z.toFixed(2)})\``
        : "`Unknown`";

    const powerplayLine = sys.controlling_power
      ? `\n⚡ **Powerplay:** **${sys.controlling_power}**${sys.powerplay_state ? ` (\`${sys.powerplay_state}\`)` : ""}`
      : "";

    const alertsSection =
      report.alerts.length > 0
        ? `\n\n**🔔 Tactical BGS Alerts**\n${report.alerts.map((a) => `• ${a}`).join("\n")}`
        : "";

    const description =
      `👑 **Controlling Faction:** **${sys.controlling_faction ?? "Unknown"}**\n` +
      `👥 **Population:** \`${formatNumber(sys.population)}\` • 🏛️ **Gov:** \`${sys.government ?? "Unknown"}\`${sys.allegiance ? ` (${sys.allegiance})` : ""}\n` +
      `🏭 **Economy:** \`${sys.primary_economy ?? "Unknown"}\` • 🛡️ **Security:** \`${sys.security ?? "Unknown"}\`` +
      powerplayLine +
      `\n📍 **Coords:** ${coordsText} • 🕒 **Updated:** ${formatRelativeTimestamp(sys.updated_at)}` +
      alertsSection;

    const embed = createPphEmbed({
      title: `🌌 System BGS Report — ${sys.name}`,
      description,
      color: PPH_COLORS.INFO,
    });

    if (report.factions.length === 0) {
      embed.addFields({
        name: "📊 Minor Faction Standings",
        value: "*No minor faction BGS data recorded for this system yet.*",
        inline: false,
      });
    } else {
      for (let i = 0; i < Math.min(report.factions.length, 10); i++) {
        embed.addFields(formatFactionField(report.factions[i]!, i));
      }
    }

    const stationCount = report.stations.length;
    const carrierNote =
      report.fleetCarrierCount > 0
        ? ` (+ \`${report.fleetCarrierCount}\` Fleet Carrier${report.fleetCarrierCount === 1 ? "" : "s"})`
        : "";

    if (stationCount === 0) {
      embed.addFields({
        name: `🎡 System Stations & Ports (0)${carrierNote}`,
        value: "*No permanent stations recorded in this system.*",
        inline: false,
      });
    } else {
      const maxStationsShown = 8;
      const shown = report.stations.slice(0, maxStationsShown);
      const lines = shown.map(formatStationLine);
      if (stationCount > maxStationsShown) {
        lines.push(`*…and ${stationCount - maxStationsShown} more station(s).*`);
      }

      embed.addFields({
        name: `🎡 System Stations & Ports (${stationCount})${carrierNote}`,
        value: lines.join("\n"),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default systemReportCommand;
