import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import { config } from "./config.js";

/**
 * Fast in-memory plate → TIN lookup backed by a Google Sheet.
 *
 * The whole sheet is loaded into a Map on startup (and refreshed every
 * LOOKUP_REFRESH_SECONDS). Reads are O(1) so MotoPack's auto-fill feels
 * instant — typically a few milliseconds inside the relay process plus
 * network round-trip to the phone.
 *
 * The service account email (`sms-sync-service@lmp-sms-sync...`) must be
 * shared as Viewer on the sheet; otherwise the load fails with 403.
 */

const cache: Map<string, string> = new Map();
let lastLoaded = 0;
let lastError = "";

function normPlate(s: string): string {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "");
}
function normTin(s: string): string {
  return String(s || "").replace(/\D+/g, ""); // strip hyphens / spaces / anything non-digit
}

async function buildClient(): Promise<sheets_v4.Sheets> {
  if (!config.GOOGLE_CREDENTIALS_B64) {
    throw new Error("GOOGLE_CREDENTIALS_B64 is not set");
  }
  const json = Buffer.from(config.GOOGLE_CREDENTIALS_B64, "base64").toString("utf-8");
  const creds = JSON.parse(json);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() as never });
}

/** Resolve the sheet tab's title from its gid (sheetId). */
async function resolveTabTitle(sheets: sheets_v4.Sheets): Promise<string> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.LOOKUP_SHEET_ID,
    fields: "sheets(properties(sheetId,title))",
  });
  const tabs = meta.data.sheets ?? [];
  const hit = tabs.find((t) => t.properties?.sheetId === config.LOOKUP_SHEET_GID);
  if (!hit?.properties?.title) {
    throw new Error(`gid ${config.LOOKUP_SHEET_GID} not found in spreadsheet`);
  }
  return hit.properties.title;
}

/** Pull columns B (plate) and I (TIN) for the configured tab. */
async function loadOnce(): Promise<void> {
  const sheets = await buildClient();
  const title = await resolveTabTitle(sheets);
  // Use a batched single get so plate + tin come back aligned. Range B:I means
  // we get [plate, C, D, E, F, G, H, tin]; we only read [0] and [7].
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.LOOKUP_SHEET_ID,
    range: `${title}!B:I`,
    majorDimension: "ROWS",
  });
  const rows = res.data.values ?? [];
  const next = new Map<string, string>();
  for (const r of rows) {
    const plate = normPlate(r[0] ?? "");
    const tin = normTin(r[7] ?? "");
    if (!plate || !tin) continue;
    // Skip the obvious header row (plate would be literal "MOTORCYCLE NUMBER" or similar).
    if (!/^MC\d{3}[A-Z]{3}$/.test(plate)) continue;
    if (tin.length !== 9) continue;
    next.set(plate, tin);
  }
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  lastLoaded = Date.now();
  lastError = "";
  console.log(`[sheets] loaded ${cache.size} plate→TIN entries from "${title}"`);
}

export async function startSheetsCache(): Promise<void> {
  if (!config.GOOGLE_CREDENTIALS_B64) {
    console.log("[sheets] GOOGLE_CREDENTIALS_B64 blank — TIN lookup disabled");
    return;
  }
  const refresh = async () => {
    try { await loadOnce(); }
    catch (e) {
      lastError = (e as Error).message;
      console.error("[sheets] refresh failed:", lastError);
    }
  };
  // Kick off the first load in the background so the server starts fast.
  void refresh();
  setInterval(refresh, config.LOOKUP_REFRESH_SECONDS * 1000);
}

export function lookupTin(plate: string): string | null {
  return cache.get(normPlate(plate)) ?? null;
}

export function lookupStats() {
  return {
    enabled: !!config.GOOGLE_CREDENTIALS_B64,
    entries: cache.size,
    lastLoadedAt: lastLoaded || null,
    lastError: lastError || null,
    sheetId: config.LOOKUP_SHEET_ID,
    gid: config.LOOKUP_SHEET_GID,
  };
}
