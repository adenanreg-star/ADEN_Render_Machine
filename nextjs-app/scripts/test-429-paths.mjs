#!/usr/bin/env node
/**
 * Uji jalur batas render secara lokal, tanpa memakai kuota Gemini sungguhan.
 *
 * Yang diuji:
 *   1. Kuota render per IP (DAILY_IMAGE_QUOTA) sampai 429.
 *   2. Anggaran render global harian (DAILY_IMAGE_BUDGET) sampai 429.
 *   3. Normalisasi IPv6 ke blok /64 (alamat berbeda di blok yang sama berbagi kuota).
 *   4. Permintaan teks tidak menghabiskan kuota gambar.
 *   5. Timeout panggilan gambar ke Gemini (GEMINI_IMAGE_TIMEOUT_SECONDS).
 *   6. Header sisa jatah (x-render-*) dan GET /api/gemini.
 *
 * Gemini diarahkan ke server tiruan lokal lewat GEMINI_API_BASE_URL, dan semua
 * counter memakai D1 lokal (wrangler dev --local --persist-to) dengan batas
 * kecil. Tidak ada network ke Gemini/Cloudflare dan tidak ada secret asli.
 *
 * Pemakaian:
 *   npm run test:limits              # build ulang lalu jalankan semua skenario
 *   npm run test:limits -- --keep    # simpan log & state wrangler untuk diperiksa
 *   npm run test:limits -- --skip-build  # pakai freebuff-sites-build yang sudah ada
 *
 * Prasyarat: `npm ci` sudah dijalankan (butuh wrangler & OpenNext di
 * node_modules), karena uji ini menjalankan build OpenNext lalu `wrangler dev`.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const BUILD_DIR = path.join(APP_DIR, "freebuff-sites-build");
const ENTRY = path.join(BUILD_DIR, "entry.js");
const ASSETS_DIR = path.join(BUILD_DIR, "assets");
const WRANGLER = path.join(APP_DIR, "node_modules", ".bin", "wrangler");
const OPENNEXT = path.join(APP_DIR, "node_modules", ".bin", "opennextjs-cloudflare");
const KEEP = process.argv.includes("--keep");
const SKIP_BUILD = process.argv.includes("--skip-build");

const failures = [];
let checks = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: APP_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

// ---------------------------------------------------------------------------
// Server tiruan Gemini: /fast/... menjawab gambar/teks, /slow/... menggantung
// cukup lama sehingga timeout di route terpicu.
// ---------------------------------------------------------------------------
const SLOW_DELAY_MS = 8000;
let mockServer = null;
let mockPort = 0;

async function startMockGemini() {
  mockPort = await freePort();
  mockServer = createServer((req, res) => {
    const url = req.url || "";
    req.resume();
    req.on("end", () => {
      const slow = url.startsWith("/slow/");
      const send = () => {
        if (res.writableEnded) return;
        const isImage = url.includes("nano-banana");
        const body = isImage
          ? {
              candidates: [
                {
                  content: {
                    parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
                  },
                },
              ],
            }
          : { candidates: [{ content: { parts: [{ text: "{}" }] } }] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (slow) setTimeout(send, SLOW_DELAY_MS);
      else send();
    });
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(mockPort, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${mockPort}`;
}

// ---------------------------------------------------------------------------
// Satu instance wrangler dev per skenario supaya counter D1 tiap skenario
// mulai dari nol. Config ditulis ke direktori sementara dan flag
// `global_fetch_strictly_public` sengaja tidak dipakai agar fetch ke
// 127.0.0.1 (server tiruan) diizinkan.
// ---------------------------------------------------------------------------
function wranglerConfig({ name, databaseName, vars }) {
  return {
    name,
    main: ENTRY,
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
    assets: { directory: ASSETS_DIR, binding: "ASSETS", run_worker_first: true },
    vars,
    d1_databases: [
      {
        binding: "DB",
        database_name: databaseName,
        database_id: "00000000-0000-0000-0000-000000000042",
      },
    ],
    r2_buckets: [
      { binding: "NEXT_INC_CACHE_R2_BUCKET", bucket_name: `${name}-cache` },
      { binding: "FILES", bucket_name: `${name}-files` },
    ],
    durable_objects: {
      bindings: [
        { name: "NEXT_CACHE_DO_QUEUE", class_name: "DOQueueHandler" },
        { name: "NEXT_TAG_CACHE_DO_SHARDED", class_name: "DOShardedTagCache" },
      ],
    },
    migrations: [
      {
        tag: "aden-429-test-v1",
        new_sqlite_classes: ["DOQueueHandler", "DOShardedTagCache"],
      },
    ],
  };
}

async function startWrangler({ scenario, vars, workDir }) {
  const slug = scenario.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const configPath = path.join(workDir, `${slug}.wrangler.json`);
  const stateDir = path.join(workDir, `state-${slug}`);
  const logPath = path.join(workDir, `${slug}.log`);
  const databaseName = `aden-429-${slug}`;
  const port = await freePort();

  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(wranglerConfig({ name: `aden-429-${slug}`, databaseName, vars }), null, 2)}\n`
  );

  const child = spawn(
    WRANGLER,
    ["dev", "--config", configPath, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", stateDir],
    { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) break;
    if (/Address already in use/i.test(log)) break;
    try {
      const res = await fetch(`${baseUrl}/api/gemini`, {
        headers: { "cf-connecting-ip": "198.51.100.1" },
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // server belum siap
    }
    await sleep(500);
  }

  if (!ready) {
    await stopWrangler(child);
    await writeFile(logPath, log).catch(() => {});
    throw new Error(
      `wrangler dev tidak siap untuk skenario "${scenario}".\n${log.slice(-4000)}` +
        (KEEP ? `\nLog: ${logPath}` : "")
    );
  }

  return {
    baseUrl,
    configPath,
    stateDir,
    databaseName,
    async stop() {
      await stopWrangler(child);
      await writeFile(logPath, log).catch(() => {});
      return log;
    },
  };
}

async function stopWrangler(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // sudah mati
    }
  }
}

// ---------------------------------------------------------------------------
// Permintaan ke route: POST gambar/teks atau GET status sisa jatah.
// ---------------------------------------------------------------------------
const IMAGE_BODY = {
  model: "gemini-nano-banana-2.1",
  payload: {
    contents: [{ parts: [{ text: "Render uji batas lokal." }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: "1K" } },
  },
};

const TEXT_BODY = {
  model: "gemini-3.5-flash-lite",
  payload: { contents: [{ parts: [{ text: "Balas dengan JSON kosong." }] }] },
};

async function request(baseUrl, body, ip, init = {}) {
  const options = {
    method: body ? "POST" : "GET",
    headers: { "cf-connecting-ip": ip, Accept: "application/json" },
    ...init,
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/api/gemini`, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: res.status,
    headers: res.headers,
    json,
    text,
    elapsedMs: Date.now() - startedAt,
  };
}

const header = (res, name) => res.headers.get(name);

async function d1Rows(server, sql) {
  const result = await runCommand(WRANGLER, [
    "d1",
    "execute",
    server.databaseName,
    "--local",
    "--persist-to",
    server.stateDir,
    "--config",
    server.configPath,
    "--command",
    sql,
    "--json",
  ]);
  if (result.code !== 0) return { error: result.output.slice(-1200) };
  try {
    const parsed = JSON.parse(result.output.slice(result.output.indexOf("[")));
    return { rows: parsed.flatMap((entry) => entry.results || []) };
  } catch {
    return { error: result.output.slice(-1200) };
  }
}

// ---------------------------------------------------------------------------
// Skenario
// ---------------------------------------------------------------------------
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.20";
const IP_C = "203.0.113.30";
const IP_TEXT = "198.51.100.7";
const today = new Date().toISOString().slice(0, 10);

async function scenarioQuotaAndBudget(workDir) {
  console.log("\n[1/3] Kuota per IP, anggaran global harian, dan header sisa jatah");
  const server = await startWrangler({
    scenario: "kuota-anggaran",
    workDir,
    vars: {
      GEMINI_API_KEY: "dummy-gemini-key",
      GEMINI_API_BASE_URL: `http://127.0.0.1:${mockPort}/fast`,
      DAILY_IMAGE_QUOTA: "2",
      DAILY_IMAGE_BUDGET: "3",
      RATE_LIMIT_MAX_REQUESTS: "100",
    },
  });

  try {
    const status = await request(server.baseUrl, null, IP_A);
    check("GET /api/gemini 200 sebagai status awal", status.status === 200, `status ${status.status}`);
    check("header kuota awal 2", header(status, "x-render-quota-remaining") === "2", header(status, "x-render-quota-remaining"));
    check("header anggaran awal 3", header(status, "x-render-budget-remaining") === "3", header(status, "x-render-budget-remaining"));

    const first = await request(server.baseUrl, IMAGE_BODY, IP_A);
    check("render #1 IP A 200", first.status === 200, `status ${first.status} ${first.text.slice(0, 200)}`);
    check("sisa kuota jadi 1", header(first, "x-render-quota-remaining") === "1", header(first, "x-render-quota-remaining"));
    check("sisa anggaran jadi 2", header(first, "x-render-budget-remaining") === "2", header(first, "x-render-budget-remaining"));

    const second = await request(server.baseUrl, IMAGE_BODY, IP_A);
    check("render #2 IP A 200", second.status === 200, `status ${second.status}`);
    check("sisa kuota jadi 0", header(second, "x-render-quota-remaining") === "0", header(second, "x-render-quota-remaining"));

    const third = await request(server.baseUrl, IMAGE_BODY, IP_A);
    check("render #3 IP A ditolak 429 kuota", third.status === 429, `status ${third.status}`);
    check(
      "pesan 429 menyebut kuota render harian",
      /Kuota render harian/i.test(third.json?.error || ""),
      third.json?.error
    );
    check("429 menyertakan Retry-After", Number(header(third, "Retry-After")) > 0, header(third, "Retry-After"));
    check("429 tetap memuat sisa kuota 0", header(third, "x-render-quota-remaining") === "0", header(third, "x-render-quota-remaining"));

    const otherIp = await request(server.baseUrl, IMAGE_BODY, IP_B);
    check("IP B render #1 200 (anggaran tersisa 1)", otherIp.status === 200, `status ${otherIp.status}`);
    check("sisa anggaran jadi 0", header(otherIp, "x-render-budget-remaining") === "0", header(otherIp, "x-render-budget-remaining"));

    const budgetHit = await request(server.baseUrl, IMAGE_BODY, IP_B);
    check("IP B render #2 ditolak 429 anggaran", budgetHit.status === 429, `status ${budgetHit.status}`);
    check(
      "pesan 429 menyebut anggaran render harian",
      /Anggaran render harian/i.test(budgetHit.json?.error || ""),
      budgetHit.json?.error
    );

    const freshIp = await request(server.baseUrl, null, IP_C);
    check("IP C masih punya kuota 2", header(freshIp, "x-render-quota-remaining") === "2", header(freshIp, "x-render-quota-remaining"));
    check("IP C melihat anggaran habis (0)", header(freshIp, "x-render-budget-remaining") === "0", header(freshIp, "x-render-budget-remaining"));

    const dump = await d1Rows(server, "SELECT bucket, count FROM rate_limits ORDER BY bucket");
    if (dump.error) {
      check("dump D1 lokal berhasil", false, dump.error);
    } else {
      // Counter naik juga pada percobaan yang ditolak (consume lalu periksa),
      // jadi hitungan = seluruh percobaan, bukan hanya render yang berhasil.
      const counts = Object.fromEntries(dump.rows.map((row) => [row.bucket, row.count]));
      check(`D1: anggaran ${today} = 4 percobaan`, counts[`budget:img:${today}`] === 4, JSON.stringify(counts));
      check(`D1: kuota ${IP_A} = 3 percobaan`, counts[`quota:img:${IP_A}`] === 3, JSON.stringify(counts));
      check(`D1: kuota ${IP_B} = 2 percobaan`, counts[`quota:img:${IP_B}`] === 2, JSON.stringify(counts));
    }
  } finally {
    await server.stop();
  }
}

async function scenarioIpv6AndText(workDir) {
  console.log("\n[2/3] Normalisasi IPv6 /64 dan pemisahan kuota teks vs gambar");
  const server = await startWrangler({
    scenario: "ipv6-teks",
    workDir,
    vars: {
      GEMINI_API_KEY: "dummy-gemini-key",
      GEMINI_API_BASE_URL: `http://127.0.0.1:${mockPort}/fast`,
      DAILY_IMAGE_QUOTA: "1",
      DAILY_IMAGE_BUDGET: "50",
      RATE_LIMIT_MAX_REQUESTS: "100",
    },
  });

  try {
    const first = await request(server.baseUrl, IMAGE_BODY, "2001:0db8:1:2:aaaa::1");
    check("IPv6 blok ::/64 pertama 200", first.status === 200, `status ${first.status} ${first.text.slice(0, 200)}`);

    const sameBlock = await request(server.baseUrl, IMAGE_BODY, "2001:db8:1:2:bbbb::2");
    check("alamat lain di blok /64 sama ditolak 429", sameBlock.status === 429, `status ${sameBlock.status}`);
    check(
      "pesan 429 menyebut kuota render harian",
      /Kuota render harian/i.test(sameBlock.json?.error || ""),
      sameBlock.json?.error
    );

    const otherBlock = await request(server.baseUrl, IMAGE_BODY, "2001:db8:1:3::1");
    check("blok /64 berbeda tetap 200", otherBlock.status === 200, `status ${otherBlock.status}`);

    const text = await request(server.baseUrl, TEXT_BODY, IP_TEXT);
    check("permintaan teks 200", text.status === 200, `status ${text.status}`);
    check("respons teks tidak membawa header kuota gambar", header(text, "x-render-quota-remaining") === null, header(text, "x-render-quota-remaining"));

    const imageAfterText = await request(server.baseUrl, IMAGE_BODY, IP_TEXT);
    check("gambar setelah teks tetap 200 (kuota gambar utuh)", imageAfterText.status === 200, `status ${imageAfterText.status}`);
    check("sisa kuota gambar jadi 0", header(imageAfterText, "x-render-quota-remaining") === "0", header(imageAfterText, "x-render-quota-remaining"));

    const dump = await d1Rows(server, "SELECT bucket, count FROM rate_limits ORDER BY bucket");
    if (dump.error) {
      check("dump D1 lokal berhasil", false, dump.error);
    } else {
      const counts = Object.fromEntries(dump.rows.map((row) => [row.bucket, row.count]));
      check("D1: blok 2001:db8:1:2::/64 = 2 percobaan", counts["quota:img:2001:db8:1:2::/64"] === 2, JSON.stringify(counts));
      check("D1: blok 2001:db8:1:3::/64 = 1", counts["quota:img:2001:db8:1:3::/64"] === 1, JSON.stringify(counts));
      check(`D1: bucket teks ${IP_TEXT} ada`, counts[`rl:txt:${IP_TEXT}`] === 1, JSON.stringify(counts));
    }
  } finally {
    await server.stop();
  }
}

async function scenarioTimeout(workDir) {
  console.log("\n[3/3] Timeout panggilan gambar ke Gemini");
  const server = await startWrangler({
    scenario: "timeout-gemini",
    workDir,
    vars: {
      GEMINI_API_KEY: "dummy-gemini-key",
      GEMINI_API_BASE_URL: `http://127.0.0.1:${mockPort}/slow`,
      GEMINI_IMAGE_TIMEOUT_SECONDS: "2",
      DAILY_IMAGE_QUOTA: "5",
      DAILY_IMAGE_BUDGET: "5",
      RATE_LIMIT_MAX_REQUESTS: "100",
    },
  });

  try {
    const res = await request(server.baseUrl, IMAGE_BODY, IP_A);
    check("respons 502 setelah timeout", res.status === 502, `status ${res.status} ${res.text.slice(0, 300)}`);
    check(
      "pesan menyebut batas waktu 2 detik",
      /tidak merespons dalam 2 detik/i.test(res.json?.error || ""),
      res.json?.error
    );
    check("timeout terjadi cepat (< 6 detik)", res.elapsedMs < 6000, `${res.elapsedMs} ms`);
    check("sisa kuota tercatat (4)", header(res, "x-render-quota-remaining") === "4", header(res, "x-render-quota-remaining"));
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// Persiapan build & eksekusi
// ---------------------------------------------------------------------------
async function ensureBuild() {
  if (SKIP_BUILD && existsSync(ENTRY)) {
    console.log("Melewati build (--skip-build); memakai freebuff-sites-build yang ada.");
    return;
  }
  if (!existsSync(OPENNEXT)) {
    throw new Error("Dependensi belum terpasang. Jalankan `npm ci` di nextjs-app lebih dulu.");
  }
  console.log("Membangun ulang worker OpenNext dari source saat ini...");
  // `-c` menunjuk konfigurasi Wrangler, `--openNextConfigPath` konfigurasi OpenNext.
  let result = await runCommand(OPENNEXT, [
    "build",
    "-c",
    "freebuff.wrangler.jsonc",
    "--openNextConfigPath",
    "freebuff.open-next.config.ts",
  ]);
  if (result.code !== 0) {
    result = await runCommand(OPENNEXT, ["build"]);
  }
  if (result.code !== 0 || !existsSync(ENTRY)) {
    throw new Error(`Build OpenNext gagal:\n${result.output.slice(-4000)}`);
  }
  console.log("Build selesai.");
}

async function main() {
  if (!existsSync(WRANGLER)) {
    console.error("Dependensi belum terpasang. Jalankan `npm ci` di nextjs-app lebih dulu.");
    process.exit(1);
  }

  await ensureBuild();
  const workDir = await mkdtemp(path.join(os.tmpdir(), "aden-429-test-"));
  console.log(`Direktori kerja: ${workDir}${KEEP ? " (disimpan)" : ""}`);
  const mockBase = await startMockGemini();
  console.log(`Server tiruan Gemini: ${mockBase}`);

  try {
    await scenarioQuotaAndBudget(workDir);
    await scenarioIpv6AndText(workDir);
    await scenarioTimeout(workDir);
  } finally {
    mockServer?.close();
    if (KEEP) {
      console.log(`\nLog & state wrangler disimpan di ${workDir}`);
    } else {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\n${checks - failures.length}/${checks} pemeriksaan lulus.`);
  if (failures.length) {
    console.log(`Gagal: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("Semua jalur batas render terbukti di wrangler dev lokal.");
}

main().catch((err) => {
  console.error(`\n${err?.message || err}`);
  process.exit(1);
});
