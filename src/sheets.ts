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

function normPlate(s: string): string {
  return String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
}
function normTin(s: string): string {
  return String(s ?? "").replace(/\D+/g, "");
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

/** Build plate→tin map from rows where r[1] is plate (col B) and r[8] is TIN (col I). */
function rowsToMap(rows: unknown[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const plate = normPlate((r?.[1] as string) ?? "");
    const tin = normTin((r?.[8] as string) ?? "");
    if (!/^MC\d{3}[A-Z]{3}$/.test(plate)) continue;
    if (tin.length !== 9) continue;
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
        spreadsheetId: config.LOOKUP_SHEET_ID, range: `${first}!A:I`, majorDimension: "ROWS",
      });
      lastSource = `Sheets API (${first}, gid not found)`;
      return rowsToMap(res.data.values ?? []);
    }
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.LOOKUP_SHEET_ID, range: `${hit.properties.title}!A:I`, majorDimension: "ROWS",
    });
    lastSource = `Sheets API (${hit.properties.title})`;
    return rowsToMap(res.data.values ?? []);
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
  lastSource = `Drive download (${meta.data.name ?? "?"} / ${sheetName})`;
  return rowsToMap(rows);
}

async function loadOnce(): Promise<void> {
  const authClient = await buildAuth();
  let next = await loadViaSheetsApi(authClient);
  if (!next) next = await loadViaDrive(authClient);
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
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
