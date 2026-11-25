import { NextResponse } from "next/server";

import { generateTextWithFallback } from "../../../lib/ai-text-fallback.js";
import { generateImageWithCloudflare } from "../../../lib/cloudflare-image.js";
import { geminiApiBaseUrl } from "../../../lib/gemini-endpoint.js";
import { consume, peek } from "../../../lib/rate-limit-store.js";

// ---------------------------------------------------------------------------
// Batas keras untuk endpoint publik ini.
// ---------------------------------------------------------------------------
// Diselaraskan dengan batas body hosting (Vercel memotong di ~4,5 MB) supaya
// penolakan terjadi di sini dengan pesan yang jelas, bukan di platform.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 12000;
const MAX_PARTS = 3;
const MAX_FALLBACK_IMAGES = 4;
const MAX_FALLBACK_IMAGE_CHARS = 900000;
const IMAGE_MODEL = "gemini-nano-banana-2.1";

const ALLOWED_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-nano-banana-2.1",
];
// Permintaan teks (Scan/analisis) memakai rantai fallback lintas penyedia.
const TEXT_MODELS = new Set(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const ALLOWED_MODALITIES = ["IMAGE", "TEXT"];
const ALLOWED_ASPECT_RATIOS = [
  "1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2",
  "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];
const ALLOWED_IMAGE_SIZES = ["512", "1K", "2K", "4K"];
const BASE64_PATTERN = /^[A-Za-z0-9+/=\r\n]+$/;
const IMAGE_SIZE_RANK = { "512": 0, "1K": 1, "2K": 2, "4K": 3 };

const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// Ukuran gambar keluaran termahal yang diizinkan (2K/4K jauh lebih mahal).
const CONFIGURED_IMAGE_SIZE = (process.env.MAX_IMAGE_SIZE || "").trim().toUpperCase();
const MAX_IMAGE_SIZE = IMAGE_SIZE_RANK[CONFIGURED_IMAGE_SIZE] === undefined ? "1K" : CONFIGURED_IMAGE_SIZE;

// ---------------------------------------------------------------------------
// Status penyedia cadangan gambar, dikirim sebagai header di setiap respons.
// Hanya menandai ada/tidaknya secret, tidak pernah nilainya, supaya jelas
// apakah CF_ACCOUNT_ID dan CF_API_TOKEN sudah menempel di environment ini.
// ---------------------------------------------------------------------------
const envIsSet = (name) => (process.env[name] || "").trim().length > 0;

function imageFallbackHeader() {
  const accountId = envIsSet("CF_ACCOUNT_ID");
  const apiToken = envIsSet("CF_API_TOKEN");
  const cloudflare = accountId && apiToken ? "ready" : accountId || apiToken ? "incomplete" : "missing";
  return [
    `gemini=${envIsSet("GEMINI_API_KEY") ? "ready" : "missing"}`,
    `cloudflare=${cloudflare}`,
    `cf-account-id=${accountId ? "set" : "unset"}`,
    `cf-api-token=${apiToken ? "set" : "unset"}`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Batas pemakaian per IP. Dihitung di D1 (binding `DB`) sehingga berlaku
// lintas instance serverless, bukan hanya per isolate.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX_REQUESTS = positiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 30);
const RATE_LIMIT_WINDOW_SECONDS = positiveInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 600);
const DAILY_IMAGE_QUOTA = positiveInt(process.env.DAILY_IMAGE_QUOTA, 60);
// Anggaran global harian: total render gambar lintas semua IP. Disimpan di D1
// dengan bucket per tanggal UTC, jadi batas ini berlaku untuk seluruh aplikasi
// dan tidak bisa diakali dengan berganti IP.
const DAILY_IMAGE_BUDGET = positiveInt(process.env.DAILY_IMAGE_BUDGET, 300);
const DAY_SECONDS = 24 * 60 * 60;
// Gemini bisa menggantung tanpa jawaban; tanpa batas waktu request akan mati
// bersama Worker tanpa pesan yang jelas. Bila lewat, jalur cadangan Cloudflare
// tetap dicoba.
const GEMINI_IMAGE_TIMEOUT_MS = positiveInt(process.env.GEMINI_IMAGE_TIMEOUT_SECONDS, 100) * 1000;

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Cloudflare menimpa `CF-Connecting-IP` dengan IP klien yang sebenarnya di
// edge, jadi nilai ini tidak bisa dipalsukan dari browser. Header lain hanya
// dipakai bila aplikasi dijalankan di luar Cloudflare (mis. next dev lokal),
// dan sengaja diabaikan `x-forwarded-for` yang bisa dikirim klien sendiri.
function getClientIp(req) {
  const connectingIp = (req.headers.get("cf-connecting-ip") || "").trim();
  if (connectingIp) return normalizeIp(connectingIp);
  const realIp = (req.headers.get("x-real-ip") || "").trim();
  if (realIp) return normalizeIp(realIp);
  return "unknown";
}

// Satu pengguna biasanya memegang satu blok IPv6 /64 dan bebas memakai alamat
// apa pun di dalamnya, jadi IP dinormalisasi ke /64. Tanpa ini, batas per IP
// bisa dilewati hanya dengan mengganti 64 bit terakhir alamat.
function normalizeIp(value) {
  let ip = (value || "").trim().toLowerCase();
  if (!ip) return "unknown";

  // Buang zone index (%eth0) dan port bila ada.
  if (ip.includes("%")) ip = ip.split("%")[0];
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");

  if (!ip.includes(":")) return ip;

  // Alamat IPv4-mapped (::ffff:203.0.113.9) diperlakukan sebagai IPv4 biasa.
  const mapped = ip.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const octets = mapped[2].split(".").map(Number);
    if (!octets.every((octet) => octet >= 0 && octet <= 255)) return ip;
    if (mapped[1] === "::" || mapped[1] === "::ffff:") return octets.join(".");
    ip = `${mapped[1]}${(((octets[0] << 8) | octets[1]) >>> 0).toString(16)}:${(
      ((octets[2] << 8) | octets[3]) >>>
      0
    ).toString(16)}`;
  }

  const groups = expandIpv6(ip);
  if (!groups) return ip;
  // Buang nol di depan tiap hextet supaya penulisan berbeda (0db8 vs db8)
  // tetap menghasilkan bucket yang sama.
  const prefix = groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

function expandIpv6(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups;
}

// Kunci tanggal UTC supaya anggaran global berganti tepat di tengah malam UTC
// dan tidak bergantung pada zona waktu server.
function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Sisa jatah render dikirim sebagai header pada setiap respons yang menyentuh
// kuota, sehingga klien bisa menampilkan sisa kuota per IP dan anggaran harian
// tanpa permintaan tambahan. Nilai `null` berarti belum dihitung pada request
// tersebut (mis. permintaan teks atau body yang ditolak lebih awal).
function applyUsageHeaders(response, usage) {
  if (usage.quota) {
    response.headers.set("x-render-quota-limit", String(usage.quota.limit));
    response.headers.set("x-render-quota-remaining", String(usage.quota.remaining));
    response.headers.set("x-render-quota-retry-after", String(usage.quota.retryAfter));
  }
  if (usage.budget) {
    response.headers.set("x-render-budget-limit", String(usage.budget.limit));
    response.headers.set("x-render-budget-remaining", String(usage.budget.remaining));
    response.headers.set("x-render-budget-retry-after", String(usage.budget.retryAfter));
    response.headers.set("x-render-budget-date", utcDayKey());
  }
  return response;
}

function tooMany(message, retryAfter) {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfter || 1)) } }
  );
}

function fail(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Validasi payload. Semua yang diteruskan ke Gemini disusun ulang dari field
// yang dikenal di bawah ini, jadi properti asing otomatis dibuang dan tidak
// perlu dicek satu per satu.
// ---------------------------------------------------------------------------
function sanitizeParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    return { error: `Payload.contents.parts harus berisi 1-${MAX_PARTS} bagian.` };
  }

  const clean = [];
  for (const part of parts) {
    if (!isPlainObject(part)) {
      return { error: "Payload.contents.parts tidak valid." };
    }

    if (typeof part.text === "string") {
      if (part.text.length === 0 || part.text.length > MAX_PROMPT_CHARS) {
        return { error: `Teks prompt harus 1-${MAX_PROMPT_CHARS} karakter.` };
      }
      clean.push({ text: part.text });
      continue;
    }

    const inline = part.inlineData;
    if (!isPlainObject(inline)) {
      return { error: "Setiap part harus berisi 'text' atau 'inlineData'." };
    }
    if (!ALLOWED_MIME_TYPES.includes(inline.mimeType)) {
      return { error: "Tipe gambar tidak didukung (hanya PNG, JPEG, WEBP)." };
    }
    if (typeof inline.data !== "string" || inline.data.length === 0) {
      return { error: "Data gambar tidak valid." };
    }
    if (inline.data.length > MAX_IMAGE_BASE64_CHARS) {
      return { error: "Ukuran gambar terlalu besar." };
    }
    if (!BASE64_PATTERN.test(inline.data)) {
      return { error: "Data gambar bukan base64 yang valid." };
    }
    clean.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
  }

  return { parts: clean };
}

function sanitizeGenerationConfig(config) {
  if (config === undefined) return { config: null };
  if (!isPlainObject(config)) return { error: "generationConfig tidak valid." };

  const clean = {};

  if (config.temperature !== undefined) {
    if (typeof config.temperature !== "number" || config.temperature < 0 || config.temperature > 2) {
      return { error: "temperature harus angka 0-2." };
    }
    clean.temperature = config.temperature;
  }

  if (config.seed !== undefined) {
    if (!Number.isInteger(config.seed) || config.seed < 0) {
      return { error: "seed harus bilangan bulat non-negatif." };
    }
    clean.seed = config.seed;
  }

  if (config.responseModalities !== undefined) {
    const modes = config.responseModalities;
    if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !ALLOWED_MODALITIES.includes(mode))) {
      return { error: "responseModalities tidak valid." };
    }
    clean.responseModalities = [...new Set(modes)];
  }

  if (config.imageConfig !== undefined) {
    const imageConfig = config.imageConfig;
    if (!isPlainObject(imageConfig)) return { error: "imageConfig tidak valid." };

    if (imageConfig.aspectRatio !== undefined) {
      if (!ALLOWED_ASPECT_RATIOS.includes(imageConfig.aspectRatio)) {
        return { error: "aspectRatio tidak didukung." };
      }
      clean.imageConfig = { aspectRatio: imageConfig.aspectRatio };
    }

    if (imageConfig.imageSize !== undefined) {
      if (!ALLOWED_IMAGE_SIZES.includes(imageConfig.imageSize)) {
        return { error: "imageSize tidak didukung (512, 1K, 2K, 4K)." };
      }
      clean.imageConfig = { ...clean.imageConfig, imageSize: imageConfig.imageSize };
    }
  }

  return { config: clean };
}

function sanitizePayload(payload) {
  if (!isPlainObject(payload)) return { error: "Payload tidak valid." };

  const contents = payload.contents;
  if (!Array.isArray(contents) || contents.length !== 1) {
    return { error: "Payload.contents harus berisi tepat 1 content." };
  }
  if (!isPlainObject(contents[0])) return { error: "Payload.contents tidak valid." };

  const parts = sanitizeParts(contents[0].parts);
  if (parts.error) return { error: parts.error };

  const config = sanitizeGenerationConfig(payload.generationConfig);
  if (config.error) return { error: config.error };

  const clean = { contents: [{ role: "user", parts: parts.parts }] };
  if (config.config && Object.keys(config.config).length > 0) {
    clean.generationConfig = config.config;
  }
  return { payload: clean };
}

// Salinan gambar kecil khusus fallback Cloudflare Workers AI. Model gambar di
// sana hanya menerima input < 512x512, sedangkan gambar untuk Gemini boleh
// sampai 2048px, jadi frontend mengirim versi kecil terpisah di field ini.
// Opsional: tanpa field ini fallback memakai inlineData asli apa adanya.
function sanitizeFallbackImages(value) {
  if (value === undefined) return { images: null };
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FALLBACK_IMAGES) {
    return { error: `fallbackImages harus berisi 1-${MAX_FALLBACK_IMAGES} gambar.` };
  }

  const images = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "fallbackImages tidak valid." };
    if (!ALLOWED_MIME_TYPES.includes(item.mimeType)) {
      return { error: "Tipe fallbackImages tidak didukung (hanya PNG, JPEG, WEBP)." };
    }
    if (typeof item.data !== "string" || item.data.length === 0) {
      return { error: "Data fallbackImages tidak valid." };
    }
    if (item.data.length > MAX_FALLBACK_IMAGE_CHARS) {
      return { error: "Ukuran fallbackImages terlalu besar." };
    }
    if (!BASE64_PATTERN.test(item.data)) {
      return { error: "Data fallbackImages bukan base64 yang valid." };
    }
    images.push({ mimeType: item.mimeType, data: item.data });
  }

  return { images };
}

// Status penyedia ikut di setiap respons (header) agar konfigurasi cadangan
// gambar bisa diperiksa tanpa memanggil model sama sekali.
export async function POST(req) {
  const usage = {};
  const response = await handlePost(req, usage);
  response.headers.set("x-ai-image-fallbacks", imageFallbackHeader());
  return applyUsageHeaders(response, usage);
}

// Status sisa jatah tanpa memakai kuota. Dipakai UI untuk menampilkan sisa
// render dan anggaran harian saat halaman dibuka (sebelum render pertama).
export async function GET(req) {
  const ip = getClientIp(req);
  const [quota, budget] = await Promise.all([
    peek(`quota:img:${ip}`, DAILY_IMAGE_QUOTA),
    peek(`budget:img:${utcDayKey()}`, DAILY_IMAGE_BUDGET),
  ]);

  const response = NextResponse.json(
    {
      quota: {
        limit: quota.limit,
        remaining: quota.remaining,
        resetInSeconds: quota.retryAfter,
        windowSeconds: DAY_SECONDS,
      },
      budget: {
        limit: budget.limit,
        remaining: budget.remaining,
        resetInSeconds: budget.retryAfter,
        date: utcDayKey(),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.headers.set("x-ai-image-fallbacks", imageFallbackHeader());
  return applyUsageHeaders(response, { quota, budget });
}

async function handlePost(req, usage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail("GEMINI_API_KEY belum dikonfigurasi di server.", 500);
  }

  const ip = getClientIp(req);

  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return fail("Content-Type harus application/json.", 415);
  }

  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return fail("Body request terlalu besar.", 413);
  }

  let body;
  try {
    const rawText = await req.text();
    if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
      return fail("Body request terlalu besar.", 413);
    }
    body = JSON.parse(rawText);
  } catch {
    return fail("Body bukan JSON yang valid.", 400);
  }

  if (!isPlainObject(body)) return fail("Body request tidak valid.", 400);
  if (!ALLOWED_MODELS.includes(body.model)) return fail("Model tidak diizinkan.", 400);

  // Batas per IP dipisah antara teks dan gambar: render gambar jauh lebih mahal
  // dan lambat, jadi pemakaian Scan/analisis teks tidak menghabiskan jatah
  // render (dan sebaliknya). IP sudah dinormalisasi ke /64 untuk IPv6.
  const isImageRequest = body.model === IMAGE_MODEL;
  const rateBucket = isImageRequest ? `rl:img:${ip}` : `rl:txt:${ip}`;
  const rate = await consume(rateBucket, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS);
  if (!rate.allowed) {
    return tooMany(
      `Batas ${RATE_LIMIT_MAX_REQUESTS} permintaan ${isImageRequest ? "render gambar" : "teks"} per ${Math.round(
        RATE_LIMIT_WINDOW_SECONDS / 60
      )} menit tercapai. Coba lagi dalam ${rate.retryAfter} detik.`,
      rate.retryAfter
    );
  }

  const sanitized = sanitizePayload(body.payload);
  if (sanitized.error) return fail(sanitized.error, 400);

  const fallbackImages = sanitizeFallbackImages(body.fallbackImages);
  if (fallbackImages.error) return fail(fallbackImages.error, 400);

  // Batas ukuran gambar keluaran: 2K/4K jauh lebih mahal daripada 1K.
  const requestedImageSize = sanitized.payload.generationConfig?.imageConfig?.imageSize;
  if (requestedImageSize && IMAGE_SIZE_RANK[requestedImageSize] > IMAGE_SIZE_RANK[MAX_IMAGE_SIZE]) {
    return fail(`imageSize ${requestedImageSize} tidak diizinkan (maksimum ${MAX_IMAGE_SIZE}).`, 400);
  }

  // Kuota render per IP, lalu anggaran global harian. Dicek setelah payload
  // valid supaya permintaan cacat tidak menghabiskan jatah, dan hanya untuk
  // model gambar yang berbiaya.
  if (isImageRequest) {
    const quota = await consume(`quota:img:${ip}`, DAILY_IMAGE_QUOTA, DAY_SECONDS);
    usage.quota = quota;
    if (!quota.allowed) {
      return tooMany(
        `Kuota render harian (${DAILY_IMAGE_QUOTA} gambar / 24 jam) untuk IP ini sudah habis. Coba lagi dalam ${quota.retryAfter} detik.`,
        quota.retryAfter
      );
    }

    // Jatah total aplikasi untuk hari ini (UTC), berlaku lintas semua IP.
    const budget = await consume(
      `budget:img:${utcDayKey()}`,
      DAILY_IMAGE_BUDGET,
      DAY_SECONDS
    );
    usage.budget = budget;
    if (!budget.allowed) {
      return tooMany(
        `Anggaran render harian Aden Studio (${DAILY_IMAGE_BUDGET} gambar / hari) sudah habis. Coba lagi dalam ${budget.retryAfter} detik.`,
        budget.retryAfter
      );
    }
  }

  if (TEXT_MODELS.has(body.model)) {
    const result = await generateTextWithFallback({
      payload: sanitized.payload,
      apiKey,
      signal: req.signal,
    });
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json(result.data, {
      headers: { "x-ai-provider": result.provider },
    });
  }

  const url = `${geminiApiBaseUrl()}/models/${body.model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Model gambar: Gemini tetap utama, lalu Cloudflare Workers AI bila Gemini
  // menolak (misalnya 429 karena kuota gambar free tier habis). Penyedia tanpa
  // secret dilewati.
  let geminiError = null;
  let geminiStatus = 502;
  let geminiTimedOut = false;
  // Batas waktu sendiri: bila Gemini menggantung, request dibatalkan dan jalur
  // cadangan Cloudflare tetap dicoba. Signal klien tetap diteruskan.
  const geminiAbort = new AbortController();
  const geminiTimer = setTimeout(() => {
    geminiTimedOut = true;
    geminiAbort.abort();
  }, GEMINI_IMAGE_TIMEOUT_MS);
  const abortOnClientClose = () => geminiAbort.abort();
  if (req.signal) req.signal.addEventListener("abort", abortOnClientClose);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sanitized.payload),
      signal: geminiAbort.signal,
    });

    const data = await response.json().catch(() => null);
    if (response.ok) {
      return NextResponse.json(data);
    }
    geminiStatus = response.status;
    geminiError = data?.error?.message || "Gemini API error";
  } catch (err) {
    geminiError = geminiTimedOut
      ? `Gemini tidak merespons dalam ${Math.round(GEMINI_IMAGE_TIMEOUT_MS / 1000)} detik.`
      : err.message || "Internal server error";
  } finally {
    clearTimeout(geminiTimer);
    if (req.signal) req.signal.removeEventListener("abort", abortOnClientClose);
  }

  const failures = [geminiError];
  let fallbackUsed = false;

  const cfAccountId = process.env.CF_ACCOUNT_ID;
  const cfApiToken = process.env.CF_API_TOKEN;
  if (cfAccountId && cfApiToken) {
    fallbackUsed = true;
    const fallback = await generateImageWithCloudflare({
      payload: sanitized.payload,
      images: fallbackImages.images,
      accountId: cfAccountId,
      apiToken: cfApiToken,
      signal: req.signal,
    });
    if (!fallback.error) {
      return NextResponse.json(fallback.data, {
        headers: { "x-ai-provider": fallback.provider },
      });
    }
    failures.push(`cloudflare: ${fallback.error}`);
  }

  // Tanpa satu pun secret cadangan, kembalikan error Gemini apa adanya.
  if (!fallbackUsed) {
    return NextResponse.json({ error: geminiError }, { status: geminiStatus });
  }
  return NextResponse.json({ error: failures.join(" | ") }, { status: 502 });
}
