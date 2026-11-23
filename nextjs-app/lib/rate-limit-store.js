// Penghitung bersama untuk rate limit & kuota.
//
// Di hosting serverless, memori proses tidak dibagi antar instance dan ikut
// hilang saat instance didaur ulang, sehingga counter in-memory hanya cadangan.
// Bila salah satu pasangan env di bawah diisi, hitungan dilakukan di Redis
// lewat REST (tanpa SDK, cukup fetch) sehingga batasnya berlaku global:
//
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL + KV_REST_API_TOKEN      (Vercel KV)
//
// Tanpa keduanya modul ini memakai Map di memori dan mencetak peringatan.

const REST_URL = (
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  ""
).replace(/\/+$/, "");

const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

export const sharedStoreEnabled = Boolean(REST_URL && REST_TOKEN);

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

async function redisConsume(key, limit, windowSeconds) {
  const res = await fetch(`${REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    // INCR dulu, lalu EXPIRE NX (hanya pasang TTL bila belum ada), lalu TTL
    // untuk menghitung Retry-After. Satu round-trip, atomik per perintah.
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, windowSeconds, "NX"],
      ["TTL", key],
    ]),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Redis REST menolak permintaan (${res.status})`);
  }

  const rows = await res.json();
  const count = Number(rows?.[0]?.result);
  const ttl = Number(rows?.[2]?.result);

  if (!Number.isFinite(count)) {
    throw new Error("Respons Redis REST tidak dikenali");
  }

  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Number.isFinite(ttl) && ttl > 0 ? ttl : windowSeconds,
  };
}

/**
 * Menambah 1 hitungan pada `key` dan memeriksa apakah masih di bawah `limit`.
 * Gagal-terbuka: bila store bersama error, permintaan tetap dilayani dengan
 * counter memori (dicatat di log) supaya pengguna tidak ikut terdampak.
 */
export async function consume(key, limit, windowSeconds) {
  if (!(limit > 0)) {
    return { allowed: true, count: 0, limit: 0, remaining: 0, retryAfter: 0 };
  }

  if (sharedStoreEnabled) {
    try {
      return await redisConsume(key, limit, windowSeconds);
    } catch (err) {
      console.warn(
        "[rate-limit] store bersama gagal, memakai memori:",
        err && err.message ? err.message : err
      );
    }
  }

  return memoryConsume(key, limit, windowSeconds);
}
