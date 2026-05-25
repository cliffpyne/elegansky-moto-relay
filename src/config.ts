import { z } from "zod";

/**
 * Cloud relay config. Lives on Render. Field staff phones upload zips here;
 * the bot PC polls and pulls them. Redis stores card metadata so the public
 * dashboard survives restarts; local disk holds the zip blobs short-term.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(10000),
  REDIS_URL: z.string().min(1),

  // Where uploaded zip blobs are stashed until the bot pulls them.
  // On Render: mount a 1GB disk at /var/data and point this there.
  // Locally: defaults to ./zips.
  ZIP_DIR: z.string().default("./zips"),

  // How long to keep a zip blob even after the bot acked it — safety net so
  // the bot can re-download if its first save failed. Auto-cleaned hourly.
  ZIP_TTL_HOURS: z.coerce.number().positive().default(48),

  // Google Sheets plate→TIN lookup. Service account JSON is base64-encoded so
  // it round-trips through Render env vars (same pattern as elegansky-m6pm).
  // Leave GOOGLE_CREDENTIALS_B64 blank to disable the lookup endpoint.
  GOOGLE_CREDENTIALS_B64: z.string().optional().default(""),
  LOOKUP_SHEET_ID: z.string().default("1HJHu0nI_KRvkeMMI4cFYhK0IcqijCh-v"),
  // The gid of the sheet tab to read (B = plate, I = TIN with hyphens).
  LOOKUP_SHEET_GID: z.coerce.number().int().default(1065051995),
  // Refresh the in-memory cache every N seconds (default 5 min).
  LOOKUP_REFRESH_SECONDS: z.coerce.number().positive().default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid config:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
