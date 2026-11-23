import { NextResponse } from "next/server";

import { generateTextWithFallback } from "../../../lib/ai-text-fallback.js";
import { consume, sharedStoreEnabled } from "../../../lib/rate-limit-store.js";

// ---------------------------------------------------------------------------
// Batas keras untuk endpoint publik ini.
// ---------------------------------------------------------------------------
// Diselaraskan dengan batas body hosting (Vercel memotong di ~4,5 MB) supaya
// penolakan terjadi di sini dengan pesan yang jelas, bukan di platform.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 12000;
const MAX_PARTS = 3;
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

if (!sharedStoreEnabled) {
  console.warn(
    "[api/gemini] Store bersama belum dikonfigurasi (UPSTASH_REDIS_REST_URL/TOKEN atau KV_REST_API_URL/TOKEN); batas hanya berlaku per instance."
  );
}

// ---------------------------------------------------------------------------
// Batas pemakaian per IP. Dihitung di store bersama (Redis REST) bila
// dikonfigurasi, sehingga berlaku lintas instance serverless.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX_REQUESTS = positiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 30);
const RATE_LIMIT_WINDOW_SECONDS = positiveInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 600);
const DAILY_IMAGE_QUOTA = positiveInt(process.env.DAILY_IMAGE_QUOTA, 60);
const DAY_SECONDS = 24 * 60 * 60;

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
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

export async function POST(req) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fail("GEMINI_API_KEY belum dikonfigurasi di server.", 500);
  }

  const ip = getClientIp(req);

  // Dicek paling awal agar request sampah pun ikut terhitung.
  const rate = await consume(`rl:${ip}`, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS);
  if (!rate.allowed) {
    return tooMany(
      `Batas ${RATE_LIMIT_MAX_REQUESTS} permintaan per ${Math.round(
        RATE_LIMIT_WINDOW_SECONDS / 60
      )} menit tercapai. Coba lagi dalam ${rate.retryAfter} detik.`,
      rate.retryAfter
    );
  }

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

  const sanitized = sanitizePayload(body.payload);
  if (sanitized.error) return fail(sanitized.error, 400);

  // Batas ukuran gambar keluaran: 2K/4K jauh lebih mahal daripada 1K.
  const requestedImageSize = sanitized.payload.generationConfig?.imageConfig?.imageSize;
  if (requestedImageSize && IMAGE_SIZE_RANK[requestedImageSize] > IMAGE_SIZE_RANK[MAX_IMAGE_SIZE]) {
    return fail(`imageSize ${requestedImageSize} tidak diizinkan (maksimum ${MAX_IMAGE_SIZE}).`, 400);
  }

  // Kuota render per IP. Dicek setelah payload valid supaya permintaan cacat
  // tidak menghabiskan jatah, dan hanya untuk model gambar yang berbiaya.
  if (body.model === IMAGE_MODEL) {
    const quota = await consume(`quota:${ip}`, DAILY_IMAGE_QUOTA, DAY_SECONDS);
    if (!quota.allowed) {
      return tooMany(
        `Kuota render harian (${DAILY_IMAGE_QUOTA} gambar / 24 jam) untuk IP ini sudah habis. Coba lagi dalam ${quota.retryAfter} detik.`,
        quota.retryAfter
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sanitized.payload),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { error: data?.error?.message || "Gemini API error" },
        { status: response.status }
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 502 });
  }
}
