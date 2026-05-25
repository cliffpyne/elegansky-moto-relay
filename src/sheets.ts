import { google } from "googleapis";
import * as XLSX from "xlsx";
import { config } from "./config.js";

/**
 * Fast in-memory plate → TIN lookup.
 *
 * Handles BOTH file types stored in Google Drive:
 *   - Native Google Sheets  → Sheets API (specific tab via gid)
 *   - Uploaded .xlsx files  → Drive download + sheetjs parse
 *
 * The whole file is loaded into a Map on startup and refreshed every
 * LOOKUP_REFRESH_SECONDS. Lookups are O(1).
 *
 * The service account must have at least Viewer on the file:
 *   sms-sync-service@lmp-sms-sync.iam.gserviceaccount.com
 */

const cache: Map<string, string> = new Map();
let lastLoaded = 0;
let lastError = "";
let lastSource = "";
let lastSampleRows: unknown[][] = []; // first 10 raw rows for debugging

function normPlate(s: string): string {
  return String(s ?? "").trim().toUpperCase().replace(/[\s\-_]+/g, "");
}

/** Find the first plate-shaped substring anywhere in a cell value. */
function extractPlate(cell: unknown): string | null {
  if (cell == null) return null;
  const s = String(cell).toUpperCase().replace(/[\s\-_]+/g, "");
  const m = s.match(/MC\d{3}[A-Z]{3}/);
  return m ? m[0] : null;
}

/**
 * Extract a NEW-owner TIN from a cell. Must look like the hyphenated format
 * (e.g. "142-861-933") so we don't accidentally pick up the operator's own
 * TIN from elsewhere in the row. The operator's own TIN is always excluded.
 */
function extractValidTin(cell: unknown): string | null {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (!s) return null;
  const m = s.match(/\d{3}-\d{3}-\d{3}/);
  if (!m) return null;
  const digits = m[0].replace(/\D+/g, "");
  if (digits.length !== 9) return null;
  if (digits === config.OWN_TIN) return null;
  return digits;
}

async function buildAuth() {
  if (!config.GOOGLE_CREDENTIALS_B64) {
    throw new Error("GOOGLE_CREDENTIALS_B64 is not set");
  }
  const json = Buffer.from(config.GOOGLE_CREDENTIALS_B64, "base64").toString("utf-8");
  const creds = JSON.parse(json);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  return await auth.getClient() as never;
}

/**
 * Build plate→tin map. Plate comes from LOOKUP_PLATE_COL_IDX (default col B);
 * TIN comes from LOOKUP_TIN_COL_IDX (default col K, the hyphenated new-owner
 * TIN). Both have safe fallbacks:
 *   - if the plate cell is empty/wrong, scan all cells for the plate pattern
 *   - if the TIN cell is empty/wrong, scan cells AT-OR-AFTER the TIN col for
 *     a hyphenated TIN that isn't the operator's own
 * Rows that don't yield BOTH a plate and a TIN are skipped (we'd rather
 * auto-fill nothing than auto-fill the wrong TIN).
 */
function rowsToMap(rows: unknown[][]): Map<string, string> {
  const out = new Map<string, string>();
  const plateIdx = config.LOOKUP_PLATE_COL_IDX;
  const tinIdx = config.LOOKUP_TIN_COL_IDX;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length === 0) continue;
    let plate = extractPlate(r[plateIdx]);
    if (!plate) {
      for (const cell of r) {
        plate = extractPlate(cell);
        if (plate) break;
      }
    }
    if (!plate) continue;
    let tin = extractValidTin(r[tinIdx]);
    if (!tin) {
      for (let i = tinIdx; i < r.length; i++) {
        tin = extractValidTin(r[i]);
        if (tin) break;
      }
    }
    if (!tin) continue;
    out.set(plate, tin);
  }
  return out;
}

/** Native Google Sheet path: read just B:I via Sheets API for the requested gid. */
async function loadViaSheetsApi(authClient: never): Promise<Map<string, string> | null> {
  const sheets = google.sheets({ version: "v4", auth: authClient });
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.LOOKUP_SHEET_ID,
      fields: "sheets(properties(sheetId,title))",
    });
    const tabs = meta.data.sheets ?? [];
    const hit = tabs.find((t) => t.properties?.sheetId === config.LOOKUP_SHEET_GID);
    if (!hit?.properties?.title) {
      // Fall back to first sheet if the gid isn't present (e.g. on conversion).
      if (!tabs.length) throw new Error("spreadsheet has no sheets");
      const first = tabs[0]?.properties?.title;
      if (!first) throw new Error("first sheet has no title");
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: config.LOOKUP_SHEET_ID, range: `${first}!A:Z`, majorDimension: "ROWS",
      });
      lastSource = `Sheets API (${first}, gid not found)`;
      const rows = res.data.values ?? [];
      _rawRowsForDebug = rows as unknown[][];
      return rowsToMap(rows);
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.LOOKUP_SHEET_ID, range: `${hit.properties.title}!A:Z`, majorDimension: "ROWS",
    });
    lastSource = `Sheets API (${hit.properties.title})`;
    const rows = res.data.values ?? [];
    _rawRowsForDebug = rows as unknown[][];
    return rowsToMap(rows);
  } catch (e) {
    const msg = (e as Error).message || "";
    // "Office file" error = uploaded .xlsx; fall through to Drive download path.
    if (msg.toLowerCase().includes("office file")) return null;
    throw e;
  }
}

/** Uploaded .xlsx path: download raw bytes via Drive API + parse with sheetjs. */
async function loadViaDrive(authClient: never): Promise<Map<string, string>> {
  const drive = google.drive({ version: "v3", auth: authClient });
  const meta = await drive.files.get({
    fileId: config.LOOKUP_SHEET_ID,
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  const mime = meta.data.mimeType ?? "";
  let buf: Buffer;
  if (mime === "application/vnd.google-apps.spreadsheet") {
    // Native sheet → export as xlsx
    const res = await drive.files.export(
      { fileId: config.LOOKUP_SHEET_ID, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      { responseType: "arraybuffer" },
    );
    buf = Buffer.from(res.data as ArrayBuffer);
  } else {
    // Uploaded xlsx (or xls) → direct download
    const res = await drive.files.get(
      { fileId: config.LOOKUP_SHEET_ID, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    buf = Buffer.from(res.data as ArrayBuffer);
  }
  const wb = XLSX.read(buf, { type: "buffer" });
  // First sheet by default — gid doesn't apply to raw xlsx.
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("xlsx has no sheets");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`xlsx sheet ${sheetName} missing`);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  _rawRowsForDebug = rows;
  lastSource = `Drive download (${meta.data.name ?? "?"} / ${sheetName})`;
  return rowsToMap(rows);
}

/** Re-run from inside loadViaSheetsApi/loadViaDrive but exposing the raw rows. */
let _rawRowsForDebug: unknown[][] = [];

async function loadOnce(): Promise<void> {
  const authClient = await buildAuth();
  _rawRowsForDebug = [];
  let next = await loadViaSheetsApi(authClient);
  if (!next) next = await loadViaDrive(authClient);
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  lastSampleRows = _rawRowsForDebug.slice(0, 10);
  lastLoaded = Date.now();
  lastError = "";
  console.log(`[sheets] loaded ${cache.size} plate→TIN entries via ${lastSource}`);
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
    source: lastSource || null,
    sheetId: config.LOOKUP_SHEET_ID,
    gid: config.LOOKUP_SHEET_GID,
  };
}

/** Debug helper — first 10 raw rows + sample of cached entries. */
export function lookupDebug() {
  const sample: Array<[string, string]> = [];
  let i = 0;
  for (const [k, v] of cache) {
    sample.push([k, v]);
    if (++i >= 10) break;
  }
  return {
    entries: cache.size,
    source: lastSource,
    firstRows: lastSampleRows.map((r) =>
      Array.isArray(r) ? r.map((c) => (c == null ? null : String(c).slice(0, 40))) : r,
    ),
    sample,
  };
}
