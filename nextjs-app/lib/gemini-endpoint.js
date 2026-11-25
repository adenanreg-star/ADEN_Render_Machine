// Basis URL Gemini untuk semua jalur (gambar & teks).
//
// Nilai default selalu API resmi. `GEMINI_API_BASE_URL` hanya dipakai oleh
// harness pengujian lokal (`npm run test:limits`) agar panggilan diarahkan ke
// server tiruan, sehingga tidak perlu kredensial atau kuota sungguhan.
const DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export function geminiApiBaseUrl() {
  return (process.env.GEMINI_API_BASE_URL || DEFAULT_GEMINI_API_BASE_URL).trim().replace(/\/+$/, "");
}
