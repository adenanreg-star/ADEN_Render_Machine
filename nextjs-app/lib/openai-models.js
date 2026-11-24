// Konstanta bersama untuk penyedia OpenAI (teks & gambar).
// Semua nama model bisa ditimpa lewat environment variable di server.

export const OPENAI_API_BASE = "https://api.openai.com/v1";

// Model teks/vision cadangan terakhir. GPT-6.1 Terra dipilih karena menerima
// input gambar dan jauh lebih murah daripada Astra/Sol.
export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-6.1-terra";

// Model gambar. Sunburst dioptimalkan untuk akurasi edit, yang dibutuhkan
// alur render Arsitektur (mempertahankan geometri referensi).
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst";
