import { describe, expect, test } from "bun:test";
import { loadCommands } from "../src/bot/registry.ts";
import {
  createPphEmbed,
  formatCredits,
  formatDistanceLs,
  formatDistanceLy,
  formatInfluenceBar,
  formatPadBadge,
  formatRelativeTimestamp,
  formatStationTypeBadge,
} from "../src/bot/ui/embeds.ts";

describe("Bot Command Registry & UI Helpers", () => {
  test("auto-discovers *.command.ts files via Bun.Glob and validates schemas", async () => {
    const commands = await loadCommands(undefined, true);
    expect(commands.size).toBe(12);
    expect(commands.has("trade-route")).toBe(true);
    expect(commands.has("internal-route")).toBe(true);
    expect(commands.has("commodity-buy")).toBe(true);
    expect(commands.has("commodity-sell")).toBe(true);
    expect(commands.has("market-listings")).toBe(true);
    expect(commands.has("undermine-trade")).toBe(true);
    expect(commands.has("faction-markets")).toBe(true);
    expect(commands.has("system-report")).toBe(true);
    expect(commands.has("faction-status")).toBe(true);
    expect(commands.has("db-status")).toBe(true);
    expect(commands.has("seed-region")).toBe(true);
    expect(commands.has("help")).toBe(true);

    for (const [name, cmd] of commands.entries()) {
      expect(cmd.data.name).toBe(name);
      expect(typeof cmd.execute).toBe("function");
      const json = cmd.data.toJSON();
      expect(json.name).toBe(name);
      expect(json.description.length).toBeGreaterThan(0);
    }
  });

  test("formats credits, distances, landing pads, and station badges", () => {
    expect(formatCredits(12450)).toBe("12,450 CR");
    expect(formatCredits(12450, true)).toBe("+12,450 CR");
    expect(formatCredits(-420, true)).toBe("-420 CR");

    expect(formatDistanceLy(24.519)).toBe("24.52 Ly");
    expect(formatDistanceLs(268.4)).toBe("268 ls");
    expect(formatDistanceLs(15000)).toBe("15,000 ls ⚠️ Far SC");

    expect(formatPadBadge("L")).toBe("🟩 L");
    expect(formatPadBadge("M")).toBe("🟨 M");
    expect(formatPadBadge("S")).toBe("🟥 S");
    expect(formatPadBadge(null)).toBe("⬜ ?");

    expect(formatStationTypeBadge({ isFleetCarrier: true })).toBe("🛸 Fleet Carrier");
    expect(formatStationTypeBadge({ isColonisationVessel: true })).toBe("🏗️ Colonisation Ship");
    expect(formatStationTypeBadge({ stationType: "Outpost" })).toBe("🛰️ Outpost");
    expect(formatStationTypeBadge({ stationType: "Coriolis" })).toBe("🎡 Coriolis");

    expect(formatRelativeTimestamp("2026-10-22T16:00:00Z")).toBe("<t:1792684800:R>");
    expect(formatInfluenceBar(0.642)).toBe("`██████░░░░` **64.2%**");
    expect(formatInfluenceBar(null)).toBe("`░░░░░░░░░░` **?%**");

    const embed = createPphEmbed({ title: "Test Embed", description: "Hello Commander" });
    expect(embed.data.title).toBe("Test Embed");
    expect(embed.data.description).toBe("Hello Commander");
  });
});
