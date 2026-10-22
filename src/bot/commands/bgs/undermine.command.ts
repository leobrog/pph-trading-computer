import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  findUndermineLossRoutes,
  type PadFilter,
  type UndermineRouteRow,
  type UndermineStrategy,
} from "../../../db/queries/trading.ts";
import {
  autocompleteFactionFor,
  autocompleteStationFor,
  autocompleteSystem,
  createAutocomplete,
} from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatCredits,
  formatDistanceLs,
  formatDistanceLy,
  formatNumber,
  formatPadBadge,
  formatRelativeTimestamp,
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const ROUTES_PER_PAGE = 5;

function formatUndermineField(route: UndermineRouteRow, index: number): {
  name: string;
  value: string;
} {
  const distStr =
    route.from_system === route.target_system
      ? "In-System"
      : formatDistanceLy(route.distance_ly);

  const sourceCarrierTag = route.from_is_carrier ? " 🛸" : "";
  const ownerBadge = route.target_faction
    ? `🚩 **${route.target_faction}**${route.target_faction_state ? ` (${route.target_faction_state})` : ""}`
    : "🚩 *Unknown Owner*";

  return {
    name: `#${index + 1} • ${route.commodity_name} — Loss: ${formatCredits(-route.loss_per_ton)}/t • ${distStr}`,
    value:
      `**🎯 Target Station:** **${route.target_station}** (${route.target_system}) ${formatPadBadge(route.target_pad)} • ${formatDistanceLs(route.target_ls)}\n` +
      `└ Owner: ${ownerBadge} • Pays: **${formatCredits(route.sell_price)}** (Demand: \`${formatNumber(route.demand)}\`) • ${formatRelativeTimestamp(route.sell_updated_at)}\n` +
      `**📦 Source Supply:** **${route.from_station}**${sourceCarrierTag} (${route.from_system}) ${formatPadBadge(route.from_pad)} • ${formatDistanceLs(route.from_ls)}\n` +
      `└ Buy Price: **${formatCredits(route.buy_price)}** • Stock: \`${formatNumber(route.stock)}\` • ${formatRelativeTimestamp(route.buy_updated_at)}`,
  };
}

const undermineCommand: BotCommand = {
  category: "BGS",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("undermine-trade")
    .setDescription(
      "Finds loss trade routes (sell < buy) to inflict negative BGS influence on a target faction/station.",
    )
    .addStringOption((opt) =>
      opt
        .setName("target_system")
        .setDescription("Star system containing the station(s) to undermine")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("target_station")
        .setDescription("Specific station to dump loss trades into")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("target_faction")
        .setDescription("Target controlling minor faction to undermine")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("strategy")
        .setDescription("Loss optimization strategy (default: Minimize Credit Loss)")
        .addChoices(
          {
            name: "Budget Dumping (Smallest Credit Loss/t + High Supply)",
            value: "budget_loss",
          },
          {
            name: "Heavy Deficit (Largest Credit Loss/t)",
            value: "heavy_loss",
          },
        )
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("max_loss_per_ton")
        .setDescription("Maximum credits per ton you are willing to lose (e.g. 500)")
        .setMinValue(1)
        .setRequired(false),
    )
    .addNumberOption((opt) =>
      opt
        .setName("max_distance_ly")
        .setDescription("Max distance in Ly from supply station to target (default: 40)")
        .setMinValue(1)
        .setMaxValue(200)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_stock")
        .setDescription("Minimum supply stock at source station (default: 1000)")
        .setMinValue(1)
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("min_pad")
        .setDescription("Minimum landing pad size required (default: Large)")
        .addChoices(
          { name: "Large (L)", value: "L" },
          { name: "Medium (M or L)", value: "M" },
          { name: "Any (S, M, L, or Unknown)", value: "Any" },
        )
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("max_ls")
        .setDescription("Max supercruise distance in ls (default: 5000)")
        .setMinValue(10)
        .setRequired(false),
    )
    .addBooleanOption((opt) =>
      opt
        .setName("include_source_carriers")
        .setDescription("Allow buying from public Fleet Carriers (targets are never carriers)")
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    target_system: autocompleteSystem,
    target_station: autocompleteStationFor("target_system"),
    target_faction: autocompleteFactionFor("target_system"),
  }),

  async execute(interaction) {
    const targetSystem = interaction.options.getString("target_system");
    const targetStation = interaction.options.getString("target_station");
    const targetFaction = interaction.options.getString("target_faction");

    if (!targetSystem && !targetStation && !targetFaction) {
      const missingEmbed = createPphEmbed({
        title: "⚠️ Target Required for BGS Undermining",
        description:
          "Please specify at least one of **`target_system`**, **`target_station`**, or **`target_faction`** so the computer knows which market(s) to undermine.",
        color: PPH_COLORS.ERROR,
      });
      await interaction.reply({ embeds: [missingEmbed] });
      return;
    }

    await interaction.deferReply();

    const strategy = (interaction.options.getString("strategy") ??
      "budget_loss") as UndermineStrategy;
    const maxLossPerTon = interaction.options.getInteger("max_loss_per_ton");
    const maxDistanceLy = interaction.options.getNumber("max_distance_ly") ?? 40;
    const minStock = interaction.options.getInteger("min_stock") ?? 1000;
    const minPad = (interaction.options.getString("min_pad") ?? "L") as PadFilter;
    const maxLs = interaction.options.getInteger("max_ls") ?? 5000;
    const includeSourceCarriers =
      interaction.options.getBoolean("include_source_carriers") ?? false;

    const routes = await findUndermineLossRoutes({
      targetSystem,
      targetStation,
      targetFaction,
      maxDistanceLy,
      strategy,
      maxLossPerTon,
      minStock,
      minPad,
      maxLs,
      includeSourceCarriers,
      limit: 25,
    });

    const targetParts: string[] = [];
    if (targetSystem) targetParts.push(`System: **${targetSystem}**`);
    if (targetStation) targetParts.push(`Station: **${targetStation}**`);
    if (targetFaction) targetParts.push(`Faction: **${targetFaction}**`);

    const friendlyFireWarning =
      targetFaction?.toLowerCase().includes("people's party of heverty") ||
      routes.some((r) =>
        r.target_faction?.toLowerCase().includes("people's party of heverty"),
      )
        ? "\n⚠️ **BGS WARNING:** One or more matching stations are controlled by **People's Party of Heverty**! Selling at a loss there will hurt PPH influence."
        : "";

    const strategyLabel =
      strategy === "budget_loss"
        ? "Budget Dumping (Min Loss/t)"
        : "Heavy Deficit (Max Loss/t)";

    const headerDesc =
      `🎯 ${targetParts.join(" • ")}\n` +
      `Strategy: \`${strategyLabel}\` • Radius: \`≤ ${maxDistanceLy} Ly\` • Pad: \`${minPad}\` • Min Stock: \`${formatNumber(minStock)}\`` +
      (maxLossPerTon ? ` • Max Loss: \`-${formatNumber(maxLossPerTon)} CR/t\`` : "") +
      friendlyFireWarning;

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < routes.length; i += ROUTES_PER_PAGE) {
      const slice = routes.slice(i, i + ROUTES_PER_PAGE);
      const embed = createPphEmbed({
        title: "🚩 BGS Undermining — Loss Trade Routes",
        description: headerDesc,
        color: PPH_COLORS.UNDERMINE,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatUndermineField(slice[j]!, i + j));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: "No Loss Trade Routes Found",
      emptyDescription:
        `No loss trade routes matched ${targetParts.join(" • ")}.\n` +
        `Note: Fleet Carriers are automatically excluded as BGS targets because they have no minor faction influence. Try increasing \`max_distance_ly\` or setting \`min_pad: Any\`.`,
    });
  },
};

export default undermineCommand;
