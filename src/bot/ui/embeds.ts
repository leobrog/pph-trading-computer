import { EmbedBuilder } from "discord.js";

export const PPH_COLORS = {
  PRIMARY: 0xd32f2f, // People's Party of Heverty Crimson
  PROFIT: 0x2ecc71, // Profitable Trade Emerald
  UNDERMINE: 0xe67e22, // BGS Undermining Amber
  INFO: 0x3498db, // Informational / Status Blue
  ERROR: 0xe74c3c, // Error Red
} as const;

export const PPH_FOOTER_TEXT = "People's Party of Heverty • Trading & BGS Computer";

export interface PphEmbedOptions {
  title?: string;
  description?: string;
  color?: number;
  footerText?: string;
}

/**
 * Creates a standardized PPH-themed Discord EmbedBuilder.
 */
export function createPphEmbed(options?: PphEmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(options?.color ?? PPH_COLORS.PRIMARY)
    .setFooter({
      text: options?.footerText
        ? `${options.footerText} • ${PPH_FOOTER_TEXT}`
        : PPH_FOOTER_TEXT,
    })
    .setTimestamp();

  if (options?.title) {
    embed.setTitle(options.title);
  }
  if (options?.description) {
    embed.setDescription(options.description);
  }

  return embed;
}

/**
 * Formats an integer credit value with thousand separators and "CR" unit.
 */
export function formatCredits(amount: number, showPlusSign = false): string {
  const rounded = Math.round(amount);
  const absFormatted = Math.abs(rounded).toLocaleString("en-US");
  if (rounded < 0) {
    return `-${absFormatted} CR`;
  }
  if (rounded > 0 && showPlusSign) {
    return `+${absFormatted} CR`;
  }
  return `${absFormatted} CR`;
}

/**
 * Formats an integer/bigint quantity (stock, demand, population) with commas.
 */
export function formatNumber(value: number | bigint | null | undefined): string {
  if (value == null) return "Unknown";
  return Number(value).toLocaleString("en-US");
}

/**
 * Formats jump distance in Light Years.
 */
export function formatDistanceLy(ly: number | null | undefined): string {
  if (ly == null || Number.isNaN(ly)) return "Unknown Ly";
  return `${ly.toFixed(2)} Ly`;
}

/**
 * Formats supercruise arrival distance in light-seconds, adding a warning badge if > 10,000 ls.
 */
export function formatDistanceLs(ls: number | null | undefined): string {
  if (ls == null || Number.isNaN(ls)) return "? ls";
  const rounded = Math.round(ls);
  const formatted = `${rounded.toLocaleString("en-US")} ls`;
  return rounded > 10_000 ? `${formatted} ⚠️ Far SC` : formatted;
}

/**
 * Formats a landing pad badge (`🟩 L`, `🟨 M`, `🟥 S`, or `⬜ ?`).
 */
export function formatPadBadge(pad: string | null | undefined): string {
  switch (pad?.toUpperCase()) {
    case "L":
      return "🟩 L";
    case "M":
      return "🟨 M";
    case "S":
      return "🟥 S";
    default:
      return "⬜ ?";
  }
}

/**
 * Formats a station type badge with an intuitive icon.
 */
export function formatStationTypeBadge(input: {
  stationType?: string | null;
  isFleetCarrier?: boolean;
  isColonisationVessel?: boolean;
}): string {
  if (input.isColonisationVessel) {
    return "🏗️ Colonisation Ship";
  }
  if (input.isFleetCarrier) {
    return "🛸 Fleet Carrier";
  }
  const st = (input.stationType ?? "").toLowerCase();
  if (st.includes("outpost") && !st.includes("crater")) {
    return "🛰️ Outpost";
  }
  if (st.includes("crater") || st.includes("surface") || st.includes("settlement")) {
    return "🏙️ Surface Port";
  }
  if (st.includes("asteroid")) {
    return "☄️ Asteroid Base";
  }
  if (st.includes("megaship")) {
    return "🚀 Megaship";
  }
  return input.stationType ? `🎡 ${input.stationType}` : "🎡 Station";
}

/**
 * Formats a Date or ISO timestamp string as a native Discord relative timestamp (`<t:UNIX:R>`).
 */
export function formatRelativeTimestamp(
  dateInput: Date | string | number | null | undefined,
): string {
  if (!dateInput) return "unknown";
  const ms = dateInput instanceof Date ? dateInput.getTime() : new Date(dateInput).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const unixSeconds = Math.floor(ms / 1000);
  return `<t:${unixSeconds}:R>`;
}

/**
 * Formats a 0.0–1.0 BGS faction influence ratio into a compact progress bar and percentage.
 */
export function formatInfluenceBar(
  influence: number | null | undefined,
  width = 10,
): string {
  if (influence == null || Number.isNaN(influence)) {
    return `\`${"░".repeat(width)}\` **?%**`;
  }
  const clamped = Math.max(0, Math.min(1, influence));
  const filled = Math.round(clamped * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `\`${bar}\` **${(clamped * 100).toFixed(1)}%**`;
}
