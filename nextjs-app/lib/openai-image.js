// Cadangan model GAMBAR memakai OpenAI Images API.
//
// Dipakai hanya ketika Gemini (gemini-nano-banana-2.1) menolak permintaan,
// misalnya karena kuota gambar free tier habis (429). Bentuk balasan
// dinormalkan ke bentuk Gemini ({ candidates[0].content.parts[].inlineData })
// supaya frontend tidak perlu diubah.
//
// Endpoint:
//   - POST /v1/images/edits        (ada gambar referensi)
//   - POST /v1/images/generations  (tanpa gambar referensi)
//
// Dua environment variable opsional:
//   OPENAI_IMAGE_MODEL    default "gpt-image-2.5-sunburst"
//   OPENAI_IMAGE_QUALITY  default "high" (low | medium | high | auto)

import { DEFAULT_OPENAI_IMAGE_MODEL, OPENAI_API_BASE } from "./openai-models.js";

const IMAGE_TIMEOUT_MS = 120000;

// OpenAI hanya menerima ukuran kelipatan 16 dengan rasio maksimum 3:1 dan
// total piksel 655.360-8.294.400. Nilai di bawah dipilih agar rasio dari UI
// tetap mendekati aslinya.
const SIZE_BY_ASPECT_RATIO = {
  "1:1": "1024x1024",
  "4:5": "1024x1280",
  "5:4": "1280x1024",
  "3:4": "960x1280",
  "4:3": "1280x960",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
  "9:16": "864x1536",
  "16:9": "1536x864",
  "21:9": "1568x672",
  // Rasio di luar batas 3:1 dipotong ke 3:1.
  "1:4": "640x1920",
  "4:1": "1920x640",
  "1:8": "640x1920",
  "8:1": "1920x640",
};

// Buffer tidak selalu tersedia di runtime Worker, jadi konversi base64 dibuat manual.
async function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function toGeminiImageShape(base64, mimeType) {
  return {
    candidates: [
      {
        content: { parts: [{ inlineData: { mimeType, data: base64 } }], role: "model" },
        finishReason: "STOP",
        index: 0,
      },
    ],
  };
}

function withTimeout(signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, IMAGE_TIMEOUT_MS);

  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", forwardAbort);
    },
  };
}

/**
 * Merender gambar lewat OpenAI dari payload yang sudah disanitasi route.
 * Mengembalikan { data, provider } atau { error }.
 */
export async function generateImageWithOpenAi({ payload, apiKey, signal }) {
  const model = (process.env.OPENAI_IMAGE_MODEL || "").trim() || DEFAULT_OPENAI_IMAGE_MODEL;
  const quality = (process.env.OPENAI_IMAGE_QUALITY || "").trim().toLowerCase() || "high";
  const parts = payload.contents?.[0]?.parts || [];

  const images = parts
    .filter((part) => part.inlineData && part.inlineData.data)
    .map((part) => ({
      image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
    }));
  const prompt = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

  if (!prompt) return { error: "Prompt gambar kosong." };

  const aspectRatio = payload.generationConfig?.imageConfig?.aspectRatio;
  const size = SIZE_BY_ASPECT_RATIO[aspectRatio] || "1280x960";

  const body = { model, prompt, size, quality, output_format: "png", n: 1 };
  if (images.length) body.images = images;

  const url = images.length
    ? `${OPENAI_API_BASE}/images/edits`
    : `${OPENAI_API_BASE}/images/generations`;

  const guard = withTimeout(signal);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        data?.error?.message || `OpenAI menolak permintaan gambar (${res.status})`;
      throw new Error(message);
    }

    const first = data?.data?.[0];
    if (first?.b64_json) {
      return { data: toGeminiImageShape(first.b64_json, "image/png"), provider: `openai:${model}` };
    }

    // Sebagian penyedia mengembalikan URL, bukan base64: ambil isinya di server
    // agar frontend tetap menerima inlineData.
    if (first?.url) {
      const imageRes = await fetch(first.url);
      if (!imageRes.ok) throw new Error("Gambar OpenAI tidak bisa diunduh.");
      const mimeType = imageRes.headers.get("content-type") || "image/png";
      return {
        data: toGeminiImageShape(await toBase64(await imageRes.arrayBuffer()), mimeType),
        provider: `openai:${model}`,
      };
    }

    throw new Error("OpenAI tidak mengembalikan gambar.");
  } catch (err) {
    if (err && err.name === "AbortError" && guard.isTimedOut()) {
      return { error: `OpenAI tidak merespons (timeout ${IMAGE_TIMEOUT_MS / 1000} detik).` };
    }
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    guard.cleanup();
  }
}
