# Aden Studio — Panduan Deploy & Google Sites

1. **Deploy Produksi dengan Backend Proxy Aman (Vercel / Netlify):**
   - Gunakan folder `nextjs-app/`. Halaman utama `/` langsung menampilkan aplikasi (rewrite ke `nextjs-app/public/index.html`).
   - Seluruh panggilan Gemini (Scan Geometri 3D & Render/Inpainting) diarahkan ke endpoint server `/api/gemini`, sehingga API Key tidak pernah dikirim ke browser maupun disimpan di `localStorage`.
   - Set Environment Variable `GEMINI_API_KEY` di dashboard hosting (Vercel/Netlify). Jangan menaruh nilainya di file yang di-commit.
   - **Wajib untuk produksi:** binding D1 `DB`. Counter rate limit, kuota render per IP, dan anggaran render harian global disimpan di D1 sehingga berlaku lintas instance dan lokasi; tabel `rate_limits` dibuat otomatis. Tanpa binding tersebut counter kembali ke memori satu instance sehingga batas tidak benar-benar berlaku.
   - Batas bisa disetel lewat `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS` (batas per IP, dipisah untuk teks dan gambar), `DAILY_IMAGE_QUOTA` (per IP / 24 jam), `DAILY_IMAGE_BUDGET` (total aplikasi per hari UTC), `GEMINI_IMAGE_TIMEOUT_SECONDS`, dan `MAX_IMAGE_SIZE` (default `1K`, agar permintaan 2K/4K yang mahal harus dibuka secara sadar). IP IPv6 dinormalisasi ke blok /64. Endpoint menolak body di atas 4 MB, dan klien sudah memperkecil gambar (sisi terpanjang 2048 px, JPEG) sebelum mengirim.
   - Riwayat Sesi (12 item terakhir), Riwayat Revisi Aktif (10 item terakhir), dan gambar kerja terakhir (input, hasil render, dan pembanding revisi) disimpan di IndexedDB browser, jadi tetap ada setelah refresh tanpa menahan semua gambar di memori. Undo Revisi tetap bisa dipakai setelah reload.

2. **Langsung di Google Sites (Embed Code):**
   - Buka `nextjs-app/public/index.html`, salin seluruh isinya, lalu tempel di Google Sites -> Insert -> Embed -> Embed code.
   - Catatan: mode embed ini hanya untuk tampilan. Fitur Scan dan Generate tetap membutuhkan endpoint `/api/gemini` dari deploy Next.js di atas, karena API Key kini hanya ada di server.
