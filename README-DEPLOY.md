# ArchiRender Studio AI — Panduan Deploy & Google Sites

1. **Langsung di Google Sites (Embed Code):**
   - Buka `ArchiRenderStudio-Standalone.html`, salin seluruh isinya, lalu tempel di Google Sites -> Insert -> Embed -> Embed code.
   - Masukkan Gemini API Key di tombol 'Set Gemini API Key' pada pojok kanan atas aplikasi.

2. **Deploy Produksi dengan Backend Proxy Aman (Vercel / Netlify):**
   - Gunakan folder `nextjs-app/` yang menyertakan endpoint server `/api/gemini` agar API Key tersimpan aman di Environment Variable (`GEMINI_API_KEY`).
