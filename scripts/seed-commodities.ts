import { join } from "node:path";
import { closeDatabase, sql } from "../src/db/index.ts";

const FDEVIDS_BASE_URL = "https://raw.githubusercontent.com/EDCD/FDevIDs/master";
const DATA_DIR = join(import.meta.dir, "../src/db/data");

export interface CommoditySeedRow {
  fdevId: number | null;
  symbol: string;
  name: string;
  category: string;
  isRare: boolean;
}

/**
 * Normalizes an FDev commodity symbol to lowercase EDDN format
 * (e.g. "$AdvancedCatalysers_name;" or "AdvancedCatalysers" -> "advancedcatalysers").
 */
export function normalizeCommoditySymbol(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\$/, "")
    .replace(/_name;$/, "")
    .replace(/;$/, "");
}

/**
 * Parses an FDevIDs CSV file (`commodity.csv` or `rare_commodity.csv`) using its header row.
 */
export function parseCommodityCsv(csvText: string, isRare: boolean): CommoditySeedRow[] {
  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const header = lines[0]!.split(",").map((col) => col.trim().toLowerCase());
  const idIdx = header.indexOf("id");
  const symbolIdx = header.indexOf("symbol");
  const categoryIdx = header.indexOf("category");
  const nameIdx = header.indexOf("name");

  if (symbolIdx === -1 || categoryIdx === -1 || nameIdx === -1) {
    throw new Error(`Invalid commodity CSV header: ${lines[0]}`);
  }

  const rows: CommoditySeedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const rawSymbol = cols[symbolIdx]?.trim();
    const category = cols[categoryIdx]?.trim();
    const name = cols[nameIdx]?.trim();

    if (!rawSymbol || !name) {
      continue;
    }

    const rawId = idIdx !== -1 ? cols[idIdx]?.trim() : undefined;
    const parsedId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;

    rows.push({
      fdevId: Number.isNaN(parsedId) ? null : parsedId,
      symbol: normalizeCommoditySymbol(rawSymbol),
      name,
      category: category || "Unknown",
      isRare,
    });
  }

  return rows;
}

async function loadCsvWithFallback(filename: string): Promise<string> {
  const url = `${FDEVIDS_BASE_URL}/${filename}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) {
      const text = await response.text();
      if (text.includes("symbol")) {
        return text;
      }
    }
    console.warn(`[Seed] Remote fetch for ${filename} returned status ${response.status}, using bundled fallback.`);
  } catch (err) {
    console.warn(`[Seed] Could not fetch ${url} (${(err as Error).message}), using bundled fallback.`);
  }

  const fallbackPath = join(DATA_DIR, filename);
  return await Bun.file(fallbackPath).text();
}

/**
 * Seeds the `commodities` table from EDCD/FDevIDs `commodity.csv` and `rare_commodity.csv`.
 */
export async function seedCommodities(): Promise<number> {
  const [standardCsv, rareCsv] = await Promise.all([
    loadCsvWithFallback("commodity.csv"),
    loadCsvWithFallback("rare_commodity.csv"),
  ]);

  const standardRows = parseCommodityCsv(standardCsv, false);
  const rareRows = parseCommodityCsv(rareCsv, true);

  // Deduplicate by normalized symbol (standard takes precedence if any collision occurs)
  const bySymbol = new Map<string, CommoditySeedRow>();
  for (const row of [...standardRows, ...rareRows]) {
    if (!bySymbol.has(row.symbol)) {
      bySymbol.set(row.symbol, row);
    }
  }

  const allRows = Array.from(bySymbol.values());
  if (allRows.length === 0) {
    throw new Error("[Seed] No commodities parsed from CSV sources.");
  }

  await sql.begin(async (tx) => {
    for (const item of allRows) {
      await tx`
        INSERT INTO commodities (fdev_id, symbol, name, category, is_rare)
        VALUES (${item.fdevId}, ${item.symbol}, ${item.name}, ${item.category}, ${item.isRare})
        ON CONFLICT (symbol) DO UPDATE SET
          fdev_id = COALESCE(EXCLUDED.fdev_id, commodities.fdev_id),
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          is_rare = EXCLUDED.is_rare
      `;
    }
  });

  console.log(
    `[Seed] Upserted ${allRows.length} commodities (${standardRows.length} standard, ${rareRows.length} rare).`,
  );
  return allRows.length;
}

if (import.meta.main) {
  try {
    await seedCommodities();
  } catch (err) {
    console.error("[Seed] Commodity seeding failed:", err);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
