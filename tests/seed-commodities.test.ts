import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeCommoditySymbol, parseCommodityCsv } from "../scripts/seed-commodities.ts";

describe("Commodity Catalog Parser & Normalizer", () => {
  test("normalizes FDev commodity symbols to lowercase EDDN format", () => {
    expect(normalizeCommoditySymbol("AdvancedCatalysers")).toBe("advancedcatalysers");
    expect(normalizeCommoditySymbol("$AdvancedCatalysers_name;")).toBe("advancedcatalysers");
    expect(normalizeCommoditySymbol("  Gold  ")).toBe("gold");
    expect(normalizeCommoditySymbol("$gold;")).toBe("gold");
  });

  test("parses bundled commodity.csv and rare_commodity.csv accurately", async () => {
    const dataDir = join(import.meta.dir, "../src/db/data");
    const standardCsv = await Bun.file(join(dataDir, "commodity.csv")).text();
    const rareCsv = await Bun.file(join(dataDir, "rare_commodity.csv")).text();

    const standardRows = parseCommodityCsv(standardCsv, false);
    const rareRows = parseCommodityCsv(rareCsv, true);

    expect(standardRows.length).toBeGreaterThanOrEqual(250);
    expect(rareRows.length).toBeGreaterThanOrEqual(130);

    const platinum = standardRows.find((r) => r.symbol === "platinum");
    expect(platinum).toBeDefined();
    expect(platinum?.name).toBe("Platinum");
    expect(platinum?.category).toBe("Metals");
    expect(platinum?.isRare).toBe(false);
    expect(platinum?.fdevId).toBe(128049152);

    const lavianBrandy = rareRows.find((r) => r.symbol === "lavianbrandy");
    expect(lavianBrandy).toBeDefined();
    expect(lavianBrandy?.name).toBe("Lavian Brandy");
    expect(lavianBrandy?.category).toBe("Legal Drugs");
    expect(lavianBrandy?.isRare).toBe(true);
  });
});
