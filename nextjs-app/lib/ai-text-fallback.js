// Rantai fallback untuk permintaan TEKS (Scan geometri & analisis).
//
// Urutan penyedia:
//   1. gemini-3.5-flash-lite        (utama)
//   2. gemini-3.1-flash-lite        (cadangan Gemini)
//   3. Groq  (Qwen vision)          (butuh GROQ_API_KEY)
//   4. OpenRouter free models       (butuh OPENROUTER_API_KEY)
//   5. OpenAI (gpt-6.1-terra)       (butuh OPENAI_API_KEY)
//
// Penyedia tanpa API key otomatis dilewati. Semua balasan dinormalkan ke bentuk
// respons Gemini ({ candidates[0].content.parts[0].text }) supaya frontend tidak
// perlu tahu penyedia mana yang menjawab.

import { DEFAULT_OPENAI_TEXT_MODEL, OPENAI_API_BASE } from "./openai-models.js";

const GEMINI_TEXT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const GROQ_MODELS = ["qwen/qwen3.8-27b"];
const OPENROUTER_MODELS = ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free"];
const OPENAI_MODELS = [(process.env.OPENAI_TEXT_MODEL || "").trim() || DEFAULT_OPENAI_TEXT_MODEL];

const ATTEMPT_TIMEOUT_MS = 25000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function partsToOpenAiContent(parts) {
  return parts.map((part) => {
    if (typeof part.text === "string") return { type: "text", text: part.text };
    const inline = part.inlineData || {};
    return {
      type: "image_url",
      image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
    };
  });
}

function toGeminiShape(text) {
  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
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
  }, ATTEMPT_TIMEOUT_MS);

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

async function attempt(label, run) {
  try {
    const text = await run();
    if (!text || !text.trim()) {
      return { label, error: "balasan kosong" };
    }
    return { label, data: toGeminiShape(text) };
  } catch (err) {
    return { label, error: err && err.message ? err.message : String(err) };
  }
}

async function callGemini(model, payload, apiKey, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const guard = withTimeout(signal);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: guard.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || `Gemini menolak permintaan (${res.status})`);
    }
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return text;
  } catch (err) {
    if (err && err.name === "AbortError" && guard.isTimedOut()) {
      throw new Error("Gemini tidak merespons (timeout)");
    }
    throw err;
  } finally {
    guard.cleanup();
  }
}

async function callOpenAiCompatible({ url, headers, model, contents, temperature, signal }) {
  const guard = withTimeout(signal);
  try {
    const body = {
      model,
      messages: [{ role: "user", content: partsToOpenAiContent(contents.parts) }],
    };
    if (typeof temperature === "number") body.temperature = temperature;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = data?.error?.message || `${model} menolak permintaan (${res.status})`;
      throw new Error(message);
    }
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : "";
  } catch (err) {
    if (err && err.name === "AbortError" && guard.isTimedOut()) {
      throw new Error(`${model} tidak merespons (timeout)`);
    }
    throw err;
  } finally {
    guard.cleanup();
  }
}

/**
 * Menjalankan rantai penyedia teks dan mengembalikan respons berbentuk Gemini.
 * `provider` bisa dipakai untuk header diagnostik.
 */
export async function generateTextWithFallback({ payload, apiKey, signal }) {
  const contents = payload.contents[0];
  const temperature = payload.generationConfig?.temperature;
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;

  const attempts = [];
  if (apiKey) {
    for (const model of GEMINI_TEXT_MODELS) {
      attempts.push(() =>
        attempt(`gemini:${model}`, () => callGemini(model, payload, apiKey, signal))
      );
    }
  }
  if (groqKey) {
    for (const model of GROQ_MODELS) {
      attempts.push(() =>
        attempt(`groq:${model}`, () =>
          callOpenAiCompatible({
            url: GROQ_URL,
            headers: { Authorization: `Bearer ${groqKey}` },
            model,
            contents,
            temperature,
            signal,
          })
        )
      );
    }
  }
  if (openRouterKey) {
    for (const model of OPENROUTER_MODELS) {
      attempts.push(() =>
        attempt(`openrouter:${model}`, () =>
          callOpenAiCompatible({
            url: OPENROUTER_URL,
            headers: {
              Authorization: `Bearer ${openRouterKey}`,
              "HTTP-Referer": process.env.APP_ORIGIN || "https://freebuff.site",
              "X-Title": "ArchiRender Studio AI",
            },
            model,
            contents,
            temperature,
            signal,
          })
        )
      );
    }
  }
  if (openAiKey) {
    for (const model of OPENAI_MODELS) {
      attempts.push(() =>
        attempt(`openai:${model}`, () =>
          callOpenAiCompatible({
            url: `${OPENAI_API_BASE}/chat/completions`,
            headers: { Authorization: `Bearer ${openAiKey}` },
            model,
            contents,
            // Model reasoning OpenAI tidak selalu menerima temperature dari
            // payload Gemini, jadi parameter ini sengaja tidak diteruskan.
            signal,
          })
        )
      );
    }
  }

  const failures = [];
  for (const run of attempts) {
    const result = await run();
    if (result.data) return { data: result.data, provider: result.label };
    failures.push(`${result.label}: ${result.error}`);
    if (signal?.aborted) break;
  }

  return {
    error: failures.length
      ? `Semua penyedia AI gagal. ${failures.join(" | ")}`
      : "Tidak ada penyedia AI yang tersedia di server.",
  };
}
