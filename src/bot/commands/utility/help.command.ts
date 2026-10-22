import { SlashCommandBuilder } from "discord.js";
import { loadCommands } from "../../registry.ts";
import type { BotCommand, CommandCategory } from "../../types.ts";
import { createPphEmbed, PPH_COLORS } from "../../ui/embeds.ts";

const CATEGORY_ORDER: CommandCategory[] = ["Trading", "BGS", "Utility"];

const CATEGORY_TITLES: Record<CommandCategory, string> = {
  Trading: "💰 Trading & Market Intelligence",
  BGS: "🚩 BGS & Economic Operations",
  Utility: "🛠️ System & Telemetry Utilities",
};

const helpCommand: BotCommand = {
  category: "Utility",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Lists all available PPH Trading Computer slash commands."),

  async execute(interaction) {
    const commands = await loadCommands();

    const byCategory = new Map<CommandCategory, BotCommand[]>();
    for (const cat of CATEGORY_ORDER) {
      byCategory.set(cat, []);
    }

    for (const cmd of commands.values()) {
      const list = byCategory.get(cmd.category) ?? [];
      list.push(cmd);
      byCategory.set(cmd.category, list);
    }

    const embed = createPphEmbed({
      title: "📖 PPH Trading Computer — Command Reference",
      description:
        "All market and BGS commands support live autocomplete for star systems, stations, commodities, and minor factions.",
      color: PPH_COLORS.PRIMARY,
    });

    for (const cat of CATEGORY_ORDER) {
      const list = byCategory.get(cat) ?? [];
      if (list.length === 0) continue;

      const lines = list.map((cmd) => `• **\`/${cmd.data.name}\`** — ${cmd.data.description}`);
      embed.addFields({
        name: CATEGORY_TITLES[cat],
        value: lines.join("\n"),
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};

export default helpCommand;
