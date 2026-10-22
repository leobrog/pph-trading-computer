import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  type EmbedBuilder,
  type InteractionEditReplyOptions,
  MessageFlags,
} from "discord.js";
import { createPphEmbed, PPH_COLORS } from "./embeds.ts";

export interface PaginationOptions {
  emptyTitle?: string;
  emptyDescription?: string;
  timeoutMs?: number;
}

function buildPaginationRow(
  currentPage: number,
  totalPages: number,
  disabled = false,
): ActionRowBuilder<ButtonBuilder> {
  const prevBtn = new ButtonBuilder()
    .setCustomId("pph_page_prev")
    .setLabel("◀ Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || currentPage <= 0);

  const indicatorBtn = new ButtonBuilder()
    .setCustomId("pph_page_indicator")
    .setLabel(`Page ${currentPage + 1} / ${totalPages}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId("pph_page_next")
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || currentPage >= totalPages - 1);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, indicatorBtn, nextBtn);
}

/**
 * Sends one or more EmbedBuilder pages to a slash command interaction with interactive
 * Previous / Next navigation buttons.
 */
export async function sendPaginatedEmbeds(
  interaction: ChatInputCommandInteraction,
  pages: EmbedBuilder[],
  options?: PaginationOptions,
): Promise<void> {
  const sendOrEdit = async (payload: InteractionEditReplyOptions) => {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    const res = await interaction.reply({
      embeds: payload.embeds,
      components: payload.components,
      withResponse: true,
    });
    return res.resource?.message ?? (await interaction.fetchReply());
  };

  if (pages.length === 0) {
    const emptyEmbed = createPphEmbed({
      title: options?.emptyTitle ?? "No Results Found",
      description:
        options?.emptyDescription ??
        "No matching market records were found within the current search criteria and freshness window.",
      color: PPH_COLORS.INFO,
    });
    await sendOrEdit({ embeds: [emptyEmbed], components: [] });
    return;
  }

  if (pages.length === 1) {
    await sendOrEdit({ embeds: [pages[0]!], components: [] });
    return;
  }

  let currentPage = 0;
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;

  const message = await sendOrEdit({
    embeds: [pages[currentPage]!],
    components: [buildPaginationRow(currentPage, pages.length, false)],
  });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
  });

  collector.on("collect", async (btnInteraction) => {
    if (btnInteraction.user.id !== interaction.user.id) {
      await btnInteraction.reply({
        content: "Only the commander who ran this command can navigate these pages.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (btnInteraction.customId === "pph_page_prev" && currentPage > 0) {
      currentPage--;
    } else if (btnInteraction.customId === "pph_page_next" && currentPage < pages.length - 1) {
      currentPage++;
    }

    await btnInteraction.update({
      embeds: [pages[currentPage]!],
      components: [buildPaginationRow(currentPage, pages.length, false)],
    });
  });

  collector.on("end", async () => {
    try {
      await interaction.editReply({
        components: [buildPaginationRow(currentPage, pages.length, true)],
      });
    } catch {
      // Ignore if message was deleted
    }
  });
}
