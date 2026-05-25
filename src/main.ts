import { buildServer } from "./server.js";
import { cleanupOldZips } from "./store.js";
import { startSheetsCache } from "./sheets.js";
import { config } from "./config.js";

const app = buildServer();

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then(() => {
    console.log(`Moto relay listening on :${config.PORT}`);
    console.log(`Zip dir: ${config.ZIP_DIR}  ·  TTL ${config.ZIP_TTL_HOURS}h`);
  })
  .catch((e) => {
    console.error("relay failed to start:", (e as Error).message);
    process.exit(1);
  });

// Periodic blob cleanup so the disk doesn't fill up.
setInterval(() => {
  cleanupOldZips()
    .then((n) => { if (n) console.log(`cleanup: removed ${n} old zip(s)`); })
    .catch((e) => console.error("cleanup error:", (e as Error).message));
}, 60 * 60 * 1000);

// Warm the plate→TIN cache so MotoPack auto-fill is instant.
void startSheetsCache();
