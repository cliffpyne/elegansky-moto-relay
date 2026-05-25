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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid config:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
