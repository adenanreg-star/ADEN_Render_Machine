// Cadangan model GAMBAR terakhir: Cloudflare Workers AI.
//
// Urutan penyedia gambar di route: Gemini (nano-banana) -> OpenAI -> Cloudflare.
// Modul ini dipakai hanya ketika dua penyedia sebelumnya menolak. Tanpa
// CF_ACCOUNT_ID/CF_API_TOKEN (Sites Secrets) modul ini tidak pernah dipanggil,
// sehingga deploy tanpa secret tetap berjalan seperti sebelumnya.
//
// Model default: @cf/black-forest-labs/flux-2-klein-4b
//   - menerima prompt + sampai 4 gambar referensi (multipart/form-data)
//   - WAJIB: setiap gambar input berukuran lebih kecil dari 512x512. Foto dari
//     UI bisa 2048px, jadi route meneruskan salinan kecil (fallbackImages)
//     yang sudah diperkecil frontend khusus untuk jalur ini.
//   - langkah inferensi tetap 4 (model distilled), lebar/tinggi 256-1920
//   - balasan berupa JSON { result: { image: "<base64>" } }
//
// Environment variable opsional:
//   CLOUDFLARE_IMAGE_MODEL  default "@cf/black-forest-labs/flux-2-klein-4b"
//   CF_ACCOUNT_ID           ID akun Cloudflare (bukan rahasia, tapi tetap
//                           disimpan sebagai secret agar satu tempat)
//   CF_API_TOKEN            token API dengan izin Workers AI

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_CF_IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MODEL_ID_PATTERN = /^@cf\/[A-Za-z0-9._/-]+$/;
const IMAGE_TIMEOUT_MS = 120000;
const MAX_INPUT_IMAGES = 4;

// Batas lebar/tinggi model: 256-1920. Rasio dari UI sedekat mungkin, total
// piksel dijaga di kisaran 1 MP agar konsumsi neuron tetap wajar.
const SIZE_BY_ASPECT_RATIO = {
  "1:1": [1024, 1024],
  "4:5": [896, 1120],
  "5:4": [1120, 896],
  "3:4": [768, 1024],
  "4:3": [1024, 768],
  "2:3": [768, 1152],
  "3:2": [1152, 768],
  "9:16": [720, 1280],
  "16:9": [1280, 720],
  "21:9": [1512, 648],
  "1:4": [480, 1920],
  "4:1": [1920, 480],
  "1:8": [256, 1920],
  "8:1": [1920, 256],
};

function modelId() {
  const configured = (process.env.CLOUDFLARE_IMAGE_MODEL || "").trim();
  return MODEL_ID_PATTERN.test(configured) ? configured : DEFAULT_CF_IMAGE_MODEL;
}

// Buffer tidak tersedia di runtime Worker, jadi konversi base64 dibuat manual.
async function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

function fileExtension(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

// Gambar input: pakai salinan kecil dari klien bila ada (satu-satunya bentuk
// yang pasti lolos batas < 512x512), kalau tidak pakai inlineData asli.
function pickInputImages(parts, preparedImages) {
  if (Array.isArray(preparedImages) && preparedImages.length > 0) {
    return preparedImages
      .filter((image) => image && typeof image.data === "string" && image.data.length > 0)
      .slice(0, MAX_INPUT_IMAGES);
  }
  return parts
    .filter((part) => part.inlineData && part.inlineData.data)
    .map((part) => part.inlineData)
    .slice(0, MAX_INPUT_IMAGES);
}

function errorMessage(data, status) {
  const first = Array.isArray(data?.errors) ? data.errors[0] : null;
  if (first?.message) return first.message;
  if (typeof data?.error === "string") return data.error;
  return `Cloudflare Workers AI menolak permintaan gambar (${status})`;
}

/**
 * Merender gambar lewat Cloudflare Workers AI dari payload yang sudah
 * disanitasi route. Mengembalikan { data, provider } atau { error }.
 */
export async function generateImageWithCloudflare({ payload, images: preparedImages, accountId, apiToken, signal }) {
  const model = modelId();
  const parts = payload.contents?.[0]?.parts || [];

  const images = pickInputImages(parts, preparedImages);
  const prompt = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

  if (!prompt) return { error: "Prompt gambar kosong." };

  const aspectRatio = payload.generationConfig?.imageConfig?.aspectRatio;
  const [width, height] = SIZE_BY_ASPECT_RATIO[aspectRatio] || SIZE_BY_ASPECT_RATIO["4:3"];

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));
  images.forEach((image, index) => {
    // Nama field harus input_image_0..3 agar dikenali model.
    form.append(
      `input_image_${index}`,
      new Blob([base64ToBytes(image.data)], { type: image.mimeType || "image/png" }),
      `input_${index}.${fileExtension(image.mimeType)}`
    );
  });

  const url = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;

  const guard = withTimeout(signal);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
      signal: guard.signal,
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(errorMessage(data, res.status));
    }

    // Sebagian model gambar Workers AI mengembalikan byte gambar langsung.
    if (contentType.startsWith("image/")) {
      const base64 = await toBase64(await res.arrayBuffer());
      return { data: toGeminiImageShape(base64, contentType.split(";")[0]), provider: `cloudflare:${model}` };
    }

    const data = await res.json().catch(() => null);
    const image =
      (typeof data?.result?.image === "string" && data.result.image) ||
      (typeof data?.result === "string" && data.result) ||
      (typeof data?.image === "string" && data.image) ||
      null;

    if (!image) throw new Error(errorMessage(data, res.status));
    return {
      data: toGeminiImageShape(image.replace(/^data:image\/\w+;base64,/, ""), "image/png"),
      provider: `cloudflare:${model}`,
    };
  } catch (err) {
    if (err && err.name === "AbortError" && guard.isTimedOut()) {
      return { error: `Cloudflare tidak merespons (timeout ${IMAGE_TIMEOUT_MS / 1000} detik).` };
    }
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    guard.cleanup();
  }
}
