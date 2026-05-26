import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { redis } from "./redis.js";
import { config } from "./config.js";

/**
 * Cards posted by field staff (MotoPack) + their lifecycle:
 *   uploaded   → just arrived from a phone, zip on disk, bot hasn't pulled yet
 *   downloaded → bot pulled the zip; ready to process
 *   processing → bot started the transfer
 *   done       → TRA app number returned
 *   failed     → TRA error / timeout (retryable)
 */
export type Status =
  | "uploaded"    // just arrived from a phone; bot hasn't pulled yet
  | "downloaded"  // bot has the zip locally; about to process
  | "processing"  // TRA transfer in flight
  | "done"        // TRA app number returned
  | "failed"      // TRA error / timeout — retryable
  | "waiting"     // legacy local queue, not yet started
  | "issue";      // folder/filename issue — fix on the source folder

export interface Card {
  id: string;            // = the "code" (filename without .pdf)
  plate: string;
  tin: string;
  amount: string;
  efd: string;
  date: string;          // DDMMYYYY raw
  scannerName: string;
  uploadedAt: number;
  status: Status;
  appNo?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  ackedAt?: number;      // bot confirmed it has the zip safely
}

const KEY_CARD = (id: string) => `card:${id}`;
const KEY_CARDS = "cards";       // ZSET id by uploadedAt
const KEY_PENDING = "pending";   // ZSET — id is here until the bot acks the pull

await mkdir(config.ZIP_DIR, { recursive: true });
const zipPath = (id: string) => join(config.ZIP_DIR, `${id}.zip`);

export async function saveUpload(
  meta: Omit<Card, "status" | "uploadedAt">,
  zip: Buffer,
): Promise<Card> {
  const now = Date.now();
  const card: Card = { ...meta, status: "uploaded", uploadedAt: now };
  await writeFile(zipPath(card.id), zip);
  const pipe = redis.multi();
  pipe.set(KEY_CARD(card.id), JSON.stringify(card));
  pipe.zadd(KEY_CARDS, now, card.id);
  pipe.zadd(KEY_PENDING, now, card.id);
  await pipe.exec();
  return card;
}

/** Read a card by id. Returns null if not found. */
export async function getCard(id: string): Promise<Card | null> {
  const raw = await redis.get(KEY_CARD(id));
  return raw ? (JSON.parse(raw) as Card) : null;
}

/** Patch a card (no-op if it doesn't exist). */
export async function patchCard(id: string, fields: Partial<Card>): Promise<Card | null> {
  const cur = await getCard(id);
  if (!cur) return null;
  const next: Card = { ...cur, ...fields };
  await redis.set(KEY_CARD(id), JSON.stringify(next));
  return next;
}

/** Bot poll: list jobs the bot hasn't fully pulled yet (oldest first). */
export async function listPending(limit = 50): Promise<Card[]> {
  const ids = await redis.zrange(KEY_PENDING, 0, limit - 1);
  const cards: Card[] = [];
  for (const id of ids) {
    const c = await getCard(id);
    if (c) cards.push(c);
  }
  return cards;
}

/** Bot fetched the zip → drop it from the pending set. */
export async function ackPulled(id: string): Promise<void> {
  const pipe = redis.multi();
  pipe.zrem(KEY_PENDING, id);
  await pipe.exec();
  await patchCard(id, { status: "downloaded", ackedAt: Date.now() });
}

/** Stream the zip bytes back to the bot. */
export async function readZip(id: string): Promise<Buffer | null> {
  try {
    return await readFile(zipPath(id));
  } catch {
    return null;
  }
}

/** All cards, newest first, for the admin dashboard. */
export async function listCards(limit = 2000): Promise<Card[]> {
  const ids = await redis.zrevrange(KEY_CARDS, 0, limit - 1);
  const cards: Card[] = [];
  for (const id of ids) {
    const c = await getCard(id);
    if (c) cards.push(c);
  }
  return cards;
}

/** Upsert one historical card (used by bulk import and bot status sync).
 *  Never adds to the pending-pull queue — these are not for the bot to pull. */
export async function upsertHistorical(card: Card): Promise<void> {
  const pipe = redis.multi();
  pipe.set(KEY_CARD(card.id), JSON.stringify(card));
  pipe.zadd(KEY_CARDS, card.uploadedAt, card.id);
  await pipe.exec();
}

/** Does the zip blob for this card still exist on disk? */
export async function hasZip(id: string): Promise<boolean> {
  try { await stat(zipPath(id)); return true; } catch { return false; }
}

/** Put a card back in the pending-pull queue so the bot re-downloads + re-processes.
 *  Works as long as the zip blob is still on disk (within ZIP_TTL_HOURS). */
export async function requeue(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const card = await getCard(id);
  if (!card) return { ok: false, reason: "card not found" };
  if (!(await hasZip(id))) return { ok: false, reason: "zip no longer on disk (older than retention); ask the scanner to re-upload" };
  const now = Date.now();
  await redis.zadd(KEY_PENDING, now, id);
  await patchCard(id, { status: "uploaded", error: undefined, appNo: undefined, finishedAt: undefined, ackedAt: undefined, startedAt: undefined });
  return { ok: true };
}

/** Background sweep: delete zip blobs older than ZIP_TTL_HOURS. */
export async function cleanupOldZips(): Promise<number> {
  const cutoff = Date.now() - config.ZIP_TTL_HOURS * 60 * 60 * 1000;
  const ids = await redis.zrangebyscore(KEY_CARDS, 0, cutoff);
  let removed = 0;
  for (const id of ids) {
    const p = zipPath(id);
    try {
      await stat(p);
      await unlink(p);
      removed++;
    } catch {
      /* already gone — fine */
    }
  }
  return removed;
}
