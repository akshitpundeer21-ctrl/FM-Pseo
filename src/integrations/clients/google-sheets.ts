/**
 * Google Sheets v4 client.
 *
 * A spreadsheet acts as a job queue: each row is a unit of work, and the
 * orchestrator can read pending rows and write status back.
 *
 * The column layout is NOT fixed. The header row is read and used to key each
 * record, so a customer's own sheet works without the code knowing its shape.
 * A tool asks for the columns it cares about and gets whatever is there.
 */
import { IntegrationNotConfiguredError, IntegrationError } from "@/core/errors";
import { scopedLogger } from "@/core/logging/logger";
import { googleAccessToken } from "@/integrations/clients/google-auth";

const log = scopedLogger("google-sheets");
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export const SHEETS_READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface SheetsConfig {
  serviceAccountJson: string;
  spreadsheetId: string;
  sheetName?: string;
}

export interface SheetRow {
  /** 1-based row number in the sheet, so a caller can write back to it. */
  rowNumber: number;
  /** Header-keyed cell values. Missing cells are "". */
  values: Record<string, string>;
}

export interface SheetPage {
  header: string[];
  rows: SheetRow[];
  sheetName: string;
  spreadsheetTitle: string;
}

function assertConfigured(config: Partial<SheetsConfig>): asserts config is SheetsConfig {
  const missing = (["serviceAccountJson", "spreadsheetId"] as const).filter((k) => !config[k]);
  if (missing.length) throw new IntegrationNotConfiguredError("google_sheets", missing as unknown as string[]);
}

function a1(sheetName: string | undefined, range: string): string {
  // A tab name containing a quote or space must be quoted in A1 notation.
  return sheetName ? `'${sheetName.replace(/'/g, "''")}'!${range}` : range;
}

async function call<T>(config: SheetsConfig, path: string, scope: string, init: RequestInit = {}): Promise<T> {
  const token = await googleAccessToken(config.serviceAccountJson, [scope]);
  const res = await fetch(`${API}/${encodeURIComponent(config.spreadsheetId)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 403 || res.status === 404) {
    throw new IntegrationError(
      "google_sheets",
      `Google returned ${res.status}. Confirm the spreadsheet id is right and that it is shared with the service account.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IntegrationError("google_sheets", `HTTP ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Read rows, keyed by the header row.
 *
 * `filter` matches on header-keyed values, so a caller can ask for
 * `{ status: "pending" }` without knowing the column order.
 */
export async function readRows(
  config: Partial<SheetsConfig>,
  options: { limit?: number; filter?: Record<string, string> } = {},
): Promise<SheetPage> {
  assertConfigured(config);

  const meta = await call<{ properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] }>(
    config,
    "?fields=properties.title,sheets.properties.title",
    SHEETS_READ_SCOPE,
  );
  const firstTab = meta.sheets?.[0]?.properties?.title;
  const sheetName = config.sheetName || firstTab;
  if (!sheetName) throw new IntegrationError("google_sheets", "The spreadsheet has no readable tabs.");

  const data = await call<{ values?: string[][] }>(
    config,
    `/values/${encodeURIComponent(a1(sheetName, "A1:ZZ"))}?majorDimension=ROWS`,
    SHEETS_READ_SCOPE,
  );

  const grid = data.values ?? [];
  if (!grid.length) {
    return { header: [], rows: [], sheetName, spreadsheetTitle: meta.properties?.title ?? "" };
  }

  const header = grid[0].map((h) => String(h ?? "").trim());
  const limit = options.limit ?? 100;
  const rows: SheetRow[] = [];

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    const values: Record<string, string> = {};
    header.forEach((key, col) => {
      if (key) values[key] = String(cells[col] ?? "").trim();
    });

    if (options.filter) {
      const matches = Object.entries(options.filter).every(
        ([k, v]) => (values[k] ?? "").toLowerCase() === v.toLowerCase(),
      );
      if (!matches) continue;
    }

    // Skip wholly empty rows rather than returning phantom work items.
    if (Object.values(values).every((v) => !v)) continue;

    rows.push({ rowNumber: i + 1, values });
    if (rows.length >= limit) break;
  }

  log.info("read sheet rows", { sheetName, returned: rows.length, scanned: grid.length - 1 });
  return { header, rows, sheetName, spreadsheetTitle: meta.properties?.title ?? "" };
}

/**
 * Write values back into specific cells, addressed by row number and column
 * header - so a caller never has to know that "status" is column E.
 *
 * Only the named columns of the named rows are touched. Nothing else in the
 * sheet is read, cleared or reordered.
 */
export async function updateRows(
  config: Partial<SheetsConfig>,
  updates: { rowNumber: number; values: Record<string, string> }[],
): Promise<{ updatedCells: number; updatedRows: number }> {
  assertConfigured(config);
  if (!updates.length) return { updatedCells: 0, updatedRows: 0 };

  const meta = await call<{ sheets?: { properties?: { title?: string } }[] }>(
    config,
    "?fields=sheets.properties.title",
    SHEETS_WRITE_SCOPE,
  );
  const sheetName = config.sheetName || meta.sheets?.[0]?.properties?.title;
  if (!sheetName) throw new IntegrationError("google_sheets", "The spreadsheet has no writable tabs.");

  const headerData = await call<{ values?: string[][] }>(
    config,
    `/values/${encodeURIComponent(a1(sheetName, "A1:ZZ1"))}`,
    SHEETS_WRITE_SCOPE,
  );
  const header = (headerData.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  if (!header.length) throw new IntegrationError("google_sheets", "The sheet has no header row, so columns cannot be addressed by name.");

  const data: { range: string; values: string[][] }[] = [];
  const unknownColumns = new Set<string>();

  for (const update of updates) {
    for (const [column, value] of Object.entries(update.values)) {
      const index = header.indexOf(column);
      if (index === -1) {
        unknownColumns.add(column);
        continue;
      }
      data.push({ range: a1(sheetName, `${columnLetter(index)}${update.rowNumber}`), values: [[value]] });
    }
  }

  if (unknownColumns.size) {
    throw new IntegrationError(
      "google_sheets",
      `The sheet has no column(s) named: ${[...unknownColumns].join(", ")}. Present: ${header.filter(Boolean).join(", ")}.`,
    );
  }
  if (!data.length) return { updatedCells: 0, updatedRows: 0 };

  const result = await call<{ totalUpdatedCells?: number; totalUpdatedRows?: number }>(
    config,
    "/values:batchUpdate",
    SHEETS_WRITE_SCOPE,
    { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) },
  );

  log.info("updated sheet cells", { sheetName, cells: result.totalUpdatedCells ?? 0 });
  return { updatedCells: result.totalUpdatedCells ?? 0, updatedRows: result.totalUpdatedRows ?? 0 };
}

/** 0-based column index to A1 letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
