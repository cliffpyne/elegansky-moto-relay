import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyCors from "@fastify/cors";
import { z } from "zod";
import * as store from "./store.js";
import type { Card, Status } from "./store.js";
import { uiPage } from "./uiPage.js";
import { lookupTin, lookupStats, lookupDebug } from "./sheets.js";

/** Parse a queue.json row (from motoOwnership/queue.json) into a relay Card. */
function fromQueueRow(row: Record<string, unknown>): Card | null {
  const code = String(row.code ?? "");
  if (!code) return null;
  const isIssue = code.startsWith("[issue]");
  const queueStatus = String(row.status ?? "waiting");
  const status: Status = isIssue
    ? "issue"
    : (["done", "failed", "processing", "waiting"].includes(queueStatus)
        ? (queueStatus as Status)
        : "waiting");
  return {
    id: code,
    plate: String(row.plate ?? ""),
    tin: String(row.tin ?? ""),
    amount: String(row.amount ?? ""),
    efd: String(row.efd ?? ""),
    date: String(row.date ?? ""),
    scannerName: String(row.scannerName ?? "bot-pc"),
    uploadedAt: Number(row.addedAt ?? Date.now()),
    status,
    appNo: row.appNo ? String(row.appNo) : undefined,
    error: row.error ? String(row.error) : undefined,
    finishedAt: row.finishedAt ? Number(row.finishedAt) : undefined,
  };
}

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
  // Allow MotoPack (Capacitor WebView origin = https://localhost) + browsers
  // to call our /api/* endpoints. Public read-only data; no credentials.
  app.register(fastifyCors, { origin: true, credentials: false });
  app.register(fastifyMultipart, { limits: { fileSize: 32 * 1024 * 1024 } });

  app.get("/healthz", async () => ({ ok: true }));

  // --- Fast plate → TIN lookup (server-side cache, ~O(1)) ---
  app.get("/api/lookup-tin", async (req) => {
    const plate = String((req.query as { plate?: string }).plate ?? "");
    const tin = lookupTin(plate);
    return { plate, tin: tin ?? null };
  });
  app.get("/api/lookup-stats", async () => lookupStats());
  app.get("/api/lookup-debug", async () => lookupDebug());

  // --- Admin dashboard (public, read-only) ---
  app.get("/", async (_req, reply) => reply.type("text/html").send(uiPage()));

  app.get("/api/cards", async () => {
    const cards = await store.listCards();
    return { cards };
  });

  // --- Field staff upload (MotoPack) ---
  // multipart: file=<zip>, fields: id, plate, tin, amount, efd, date, scannerName
  app.post("/api/upload", async (req, reply) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let zipBuf: Buffer | null = null;
    for await (const p of parts) {
      if (p.type === "file") {
        zipBuf = await p.toBuffer();
      } else {
        fields[p.fieldname] = String(p.value);
      }
    }
    const schema = z.object({
      id: z.string().min(5),
      plate: z.string().min(1),
      tin: z.string().min(1),
      amount: z.string().min(1),
      efd: z.string().min(1),
      date: z.string().min(1),
      scannerName: z.string().min(1).default("anonymous"),
    });
    const parsed = schema.safeParse(fields);
    if (!parsed.success || !zipBuf) {
      return reply.code(400).send({ ok: false, error: "missing fields or zip file" });
    }
    const card = await store.saveUpload(parsed.data, zipBuf);
    return { ok: true, card };
  });

  // --- Bot PC poller ---
  app.get("/api/jobs", async () => ({ jobs: await store.listPending(50) }));

  app.get("/api/zip/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const buf = await store.readZip(id);
    if (!buf) return reply.code(404).send({ ok: false, error: "zip not found" });
    return reply
      .type("application/zip")
      .header("content-disposition", `attachment; filename="${id}.zip"`)
      .send(buf);
  });

  app.post("/api/jobs/:id/ack", async (req) => {
    const id = (req.params as { id: string }).id;
    await store.ackPulled(id);
    return { ok: true };
  });

  // Bot reports a card's lifecycle: processing → done / failed.
  app.post("/api/jobs/:id/status", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const schema = z.object({
      status: z.enum(["processing", "done", "failed", "issue"]),
      appNo: z.string().optional(),
      error: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.message });
    const now = Date.now();
    const patch: Partial<Card> = { status: parsed.data.status };
    if (parsed.data.appNo) patch.appNo = parsed.data.appNo;
    if (parsed.data.error) patch.error = parsed.data.error;
    if (parsed.data.status === "processing") patch.startedAt = now;
    if (parsed.data.status === "done" || parsed.data.status === "failed") patch.finishedAt = now;
    const updated = await store.patchCard(id, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: "card not found" });
    return { ok: true, card: updated };
  });

  // --- Admin actions from the public dashboard ---
  app.post("/api/jobs/:id/retry", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const r = await store.requeue(id);
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.reason });
    return { ok: true };
  });

  app.get("/api/zip-status/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    return { id, hasZip: await store.hasZip(id) };
  });

  // --- One-shot history import (queue.json from the bot PC) ---
  // Accepts either an array of rows or { items: [...] }. Idempotent.
  app.post("/api/import-history", async (req, reply) => {
    const body = req.body as unknown;
    const rows: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { items?: unknown[] })?.items)
        ? (body as { items: unknown[] }).items
        : [];
    if (!rows.length) return reply.code(400).send({ ok: false, error: "no rows" });
    let imported = 0;
    for (const r of rows) {
      const card = fromQueueRow(r as Record<string, unknown>);
      if (!card) continue;
      await store.upsertHistorical(card);
      imported++;
    }
    return { ok: true, imported, total: rows.length };
  });

  return app;
}
