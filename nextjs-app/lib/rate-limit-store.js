// Penghitung bersama untuk rate limit & kuota harian.
//
// Di hosting serverless, memori proses tidak dibagi antar instance dan ikut
// hilang saat instance didaur ulang, sehingga counter in-memory hanya cadangan.
// Karena itu hitungan disimpan di D1 (binding `DB`) yang dibagi semua instance
// di semua lokasi, dengan satu perintah UPSERT atomik per permintaan:
//
//   INSERT ... ON CONFLICT(bucket) DO UPDATE SET count = ..., reset_at = ...
//
// Tabel dibuat sendiri saat pertama dipakai (CREATE TABLE IF NOT EXISTS),
// jadi tidak perlu langkah migrasi manual. Bila binding D1 tidak ada atau
// query gagal, modul ini gagal-terbuka ke Map memori dan mencatat peringatan
// sekali per instance supaya pengguna tidak ikut terdampak.

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
)`;

const DB_LOOKUP_TTL_MS = 60_000;

let dbCache = { db: null, expires: 0 };
let schemaPromise = null;
let warnedNoStore = false;

async function getDb() {
  const now = Date.now();
  if (dbCache.expires > now) return dbCache.db;

  let db = null;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    db = context?.env?.DB ?? null;
  } catch {
    db = null;
  }

  dbCache = { db, expires: now + DB_LOOKUP_TTL_MS };
  return db;
}

// Skema cukup dijalankan sekali per isolate; promise-nya dipakai bersama agar
// permintaan yang datang bersamaan tidak menjalankan CREATE TABLE berulang.
function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.prepare(TABLE_SQL).run();
      // Buang bucket yang sudah lewat masa berlakunya agar tabel tidak tumbuh.
      await db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").bind(Date.now()).run();
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

const memoryBuckets = new Map();

function memoryConsume(key, limit, windowSeconds) {
  const now = Date.now();

  // Buang bucket kedaluwarsa agar Map tidak tumbuh tanpa batas.
  if (memoryBuckets.size > 5000) {
    for (const [bucketKey, bucket] of memoryBuckets) {
      if (bucket.reset <= now) memoryBuckets.delete(bucketKey);
    }
  }

  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.reset <= now) {
    memoryBuckets.set(key, { count: 1, reset: now + windowSeconds * 1000 });
    return { allowed: true, count: 1, limit, remaining: limit - 1, retryAfter: 0 };
  }

  bucket.count += 1;
  const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
  return {
    allowed: bucket.count <= limit,
    count: bucket.count,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter,
  };
}

async function d1Consume(db, key, limit, windowSeconds) {
  await ensureSchema(db);

  const now = Date.now();
  const resetAt = now + windowSeconds * 1000;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING count, reset_at`
    )
    .bind(key, resetAt, now, now, resetAt)
    .first();

  const count = Number(row?.count);
  const storedReset = Number(row?.reset_at);
  if (!Number.isFinite(count) || !Number.isFinite(storedReset)) {
    throw new Error("Respons D1 tidak dikenali");
  }

  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Math.max(1, Math.ceil((storedReset - now) / 1000)),
  };
}

/**
 * Menambah 1 hitungan pada `key` dan memeriksa apakah masih di bawah `limit`.
 * Gagal-terbuka: bila D1 tidak tersedia atau error, permintaan tetap dilayani
 * dengan counter memori (dicatat di log) supaya pengguna tidak ikut terdampak.
 */
export async function consume(key, limit, windowSeconds) {
  if (!(limit > 0)) {
    return { allowed: true, count: 0, limit: 0, remaining: 0, retryAfter: 0 };
  }

  const db = await getDb();
  if (db) {
    try {
      return await d1Consume(db, key, limit, windowSeconds);
    } catch (err) {
      if (!warnedNoStore) {
        warnedNoStore = true;
        console.warn(
          "[rate-limit] D1 gagal, memakai memori:",
          err && err.message ? err.message : err
        );
      }
    }
  } else if (!warnedNoStore) {
    warnedNoStore = true;
    console.warn(
      "[rate-limit] Binding D1 (DB) tidak tersedia; batas hanya berlaku per instance."
    );
  }

  return memoryConsume(key, limit, windowSeconds);
}
