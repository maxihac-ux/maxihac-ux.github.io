/**
 * sw.js — Service Worker «Српски од нуле» (v2.42.0).
 *
 * Роли:
 *  1. Пакеты (v2.21.0, поведение не менялось):
 *       /models/, /ort/        → пак sr-ru-asr-models из srpski-langpacks (3c.2)
 *       /models/... /ort/...  → из пака asr-models, если установлен; иначе сеть
 *  2. СЛОТЫ A/B (этап 4, инструкция №8 — раздельная доставка core/ui):
 *       - клиент (lib/slots) качает core-<ver>.zip и ui-<ver>.zip, проверяет
 *         sha256 КАЖДОГО файла, подписи ed25519 манифестов и совместимость,
 *         кладёт файлы в staging-кэши и активирует через slots-activate;
 *       - SW переносит staging в свободный слот (A/B) и переключает активный;
 *       - nav, /_next и /core.js отдаются из активного слота ПОВЕРХ вшитых;
 *       - сторож 120 с: нет slots-alive после первого рендера → rollback;
 *       - slots-crash (error boundary) → немедленный rollback;
 *       - вшитая связка догнала (version.json) → слоты стираются;
 *       - журнал причин — в состоянии слотов (slots-get).
 *  2a. HOT-BUNDLE (легаси v2.42.0, до миграции на слоты): быстрый патч
 *     веб-слоя БЕЗ переустановки APK (фидбек «каждый патч — 270 МБ»):
 *       - клиент (lib/hotbundle.ts) кладёт файлы бандла в кэш "srpski-hot"
 *         и активирует hot-режим через postMessage (hb-activate);
 *       - навигации и прочий веб-слой отдаются из hot-кэша ПОВЕРХ вшитых;
 *       - /audio, /models, /ort, /__pkg, /packages/baked.json, /version.json,
 *         /sw.js — НЕ перекрываются никогда (тяжёлое — паками, состояние APK
 *         — вшитым, SW обновляется только установкой APK);
 *       - инвалидация автоматическая: на каждой навигации сверяем ВШИТЫЙ
 *         /version.json (baked) с кодом бандла — APK обновился → hot-кэш
 *         стирается (fetch изнутри SW идёт мимо этого обработчика — это
 *         гарантированно вшитый файл);
 *       - сторож: нет подтверждения успешной загрузки (hb-confirm, шлют
 *         pkgs-dl.js и карточка настроек) за 120 с → сброс на вшитую версию.
 *  3. Офлайн-оболочка PWA (v2.28.8, P1 плана аудита раздела 8; v2.35.1 —
 *     фоновая ревалидация):
 *       - навигации: сеть с таймаутом → кэш оболочки → /index.html
 *         (перезагрузка без сети открывает приложение);
 *       - v2.35.1: если сеть не успела за таймаут и ответ взят из кэша,
 *         ожидание сети продолжается в фоне, свежий ответ дописывается в кэш
 *         (e.waitUntil) — следующая загрузка уже новая. Раньше свежий ответ
 *         выбрасывался: при медленном прокси пользователь мог неделями сидеть
 *         на устаревшей оболочке (фидбек «почему собрана версия 2.34.0»);
 *       - /_next/static: cache-first (immutable, контент-хэши в именах);
 *       - /audio: cache-first с FIFO-обрезкой (прослушанная озвучка офлайн);
 *       - version.json: сеть с коротким таймаутом → кэш (апдейтер жив);
 *       - прочее (иконки, манифест, шрифты): stale-while-revalidate.
 *
 * Режим задаётся при регистрации: /sw.js?mode=web — оболочка активна;
 * ?mode=native — в APK Capacitor работает пакетная логика v2.21.0 + hot-bundle
 * v2.42.0 (кэш оболочки не вмешивается и не переживает обновления APK).
 * Без параметра (старые регистрации) — web.
 *
 * Обновление: install → skipWaiting, activate → чистка кэшей прошлых версий
 * и clients.claim; навигации и version.json — сеть-первая, поэтому онлайн
 * пользователь всегда получает свежую сборку, офлайн — последний кэш.
 * v2.35.1: SHELL_VER поднят → старые кэши (включая устаревшую оболочку)
 * удаляются на activate, а свежий index.html перекачивается на install
 * (cache: "reload", мимо HTTP-кэша).
 */
"use strict";

const SHELL_VER = "v2.60.27-520"; // №53: build_export подставляет v{версия}-{код} — каждая сборка имеет свои кэши, activate стирает чужие
const SHELL_CACHE = "srpski-shell-" + SHELL_VER;
const STATIC_CACHE = "srpski-static-" + SHELL_VER;
const MEDIA_CACHE = "srpski-media-" + SHELL_VER;
const MAX_MEDIA = 1500; // ≈ 20 МБ озвучки (FIFO)
// v2.35.1: таймауты подняты (3500→7000, 2500→4000). Офлайн fetch падает
// мгновенно — таймаут касается только «сеть есть, но медленно» (прокси):
// раньше 3.5 с не хватало, и такие пользователи постоянно получали кэш.
const NAV_TIMEOUT = 7000; // мс: сколько ждём сеть для навигаций
const VER_TIMEOUT = 4000; // мс: сколько ждём сеть для version.json

const MODE = (function () {
  try {
    return new URL(self.serviceWorker.scriptURL).searchParams.get("mode") || "web";
  } catch (e) {
    return "web";
  }
})();
const SHELL_ON = MODE !== "native";

// Оболочка: минимальный набор для открытия приложения офлайн.
const SHELL_PRECACHE = [
  "/index.html",
  "/manifest.webmanifest",
  "/version.json",
  "/pwa-192.png",
  "/pwa-512.png",
  "/apple-touch-icon.png",
  "/logo.svg",
];

/* ---------- IndexedDB паков (v2.21.0, без изменений) ---------- */

const MIME = {
  ".ogg": "audio/ogg", ".json": "application/json", ".mjs": "text/javascript",
  ".wasm": "application/wasm", ".txt": "text/plain", ".onnx": "application/octet-stream",
};

function mimeOf(name) {
  const i = name.lastIndexOf(".");
  return (i >= 0 && MIME[name.slice(i)]) || "application/octet-stream";
}

let dbp = null;
// Этап 3c.2 (инструкция №8): файлы пакетов — в srpski-langpacks (store "files",
// ключ = полный путь «packs/<id>/<файл>» — как пишет FileAdapter ядра).
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open("srpski-langpacks", 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}

// Легаси-база (до завершения миграции v4): блобы «<пак>|<файл>»
let legacyDbp = null;
function legacyDb() {
  if (legacyDbp) return legacyDbp;
  legacyDbp = new Promise((res, rej) => {
    const rq = indexedDB.open("srpski-packs");
    rq.onupgradeneeded = () => { /* легаси не создаём */ };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return legacyDbp;
}

function legacyBlobOf(key) {
  return legacyDb().then((d) => new Promise((res) => {
    try {
      const rq = d.transaction("blobs", "readonly").objectStore("blobs").get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
}

function fileOf(path) {
  return db().then((d) => new Promise((res, rej) => {
    const rq = d.transaction("files", "readonly").objectStore("files").get(path);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  }));
}

function respondBlob(path) {
  return fileOf(path).then((b) => {
    if (!b) return new Response("not found", { status: 404 });
    return new Response(b, {
      headers: { "Content-Type": mimeOf(key), "Cache-Control": "no-store" },
    });
  });
}

/* ---------- HOT-BUNDLE (v2.42.0, только нативный режим) ---------- */

const HOT_CACHE = "srpski-hot";
const HOT_STATE_CACHE = "srpski-hot-state";
const HOT_STATE_KEY = "/__hot__/state";
const HOT_WATCHDOG_MS = 120000; // нет подтверждения загрузки за 2 мин → сброс
// Что hot-бандл НЕ имеет права перекрывать: состояние APK и тяжёлые данные
const HOT_NEVER = /^\/(sw\.js|version\.json|packages\/|baked\.json|__pkg\/|models\/|ort\/|audio\/)/;

async function hotState() {
  try {
    const c = await caches.open(HOT_STATE_CACHE);
    const r = await c.match(HOT_STATE_KEY);
    if (!r) return null;
    const st = await r.json();
    return st && st.code ? st : null;
  } catch (e) {
    return null;
  }
}

async function hotClear() {
  try { await caches.delete(HOT_CACHE); } catch (e) {}
  try { await caches.delete(HOT_STATE_CACHE); } catch (e) {}
}

// Вшитая версия не старее бандла? → бандл устарел, сброс.
// fetch ИЗНУТРИ SW не проходит через собственный fetch-обработчик —
// это гарантированно вшитый (baked) version.json из android_asset.
async function hotStale(st) {
  try {
    const net = fetch("/version.json?hbchk=" + Date.now(), { cache: "no-store" });
    const r = await raceTimeout(net, 1500);
    if (!r || !r.ok) return false; // проверить не смогли — считаем годным
    const j = await r.json();
    const code = parseInt(j && j.code, 10) || 0;
    return code >= st.code;
  } catch (e) {
    return false;
  }
}

async function hotRespond(req) {
  const st = await hotState();
  if (!st) return fetch(req); // hot-режим не активен — вшитые файлы
  // сторож: бандл применили, но успешной загрузки не подтвердили
  if (!st.confirmed && Date.now() - (st.activatedAt || 0) > HOT_WATCHDOG_MS) {
    await hotClear();
    return fetch(req);
  }
  // APK обновился — вшитая версия догнала/перегнала бандл
  if (await hotStale(st)) {
    await hotClear();
    return fetch(req);
  }
  const url = new URL(req.url);
  const p = url.pathname;
  if (HOT_NEVER.test(p)) return fetch(req);
  let cache = null;
  try { cache = await caches.open(HOT_CACHE); } catch (e) { return fetch(req); }
  const isNav = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isNav) {
    const cands = p.endsWith("/") ? [p + "index.html", "/index.html"] : [p, p + ".html", "/index.html"];
    for (let i = 0; i < cands.length; i++) {
      const m = await cache.match(cands[i]);
      if (m) return m;
    }
    return fetch(req);
  }
  const m = await cache.match(req);
  if (m) return m;
  return fetch(req);
}

/* ---------- СЛОТЫ A/B (этап 4, инструкция №8; docs/contracts/slots.md) ---------- */

/*
 * Раздельная доставка связки «ядро + интерфейс»: core-<ver>.zip (core.js)
 * и ui-<ver>.zip (веб-слой) ставятся в ДВА слота поверх вшитой связки APK.
 * Манифесты слоёв подписаны ed25519 (проверяет клиент при установке);
 * SW хранит состояние слотов, раздаёт файлы активного слота и
 * откатывает связку без участия пользователя:
 *   - сторож 120 с: страница не подтвердила живость (slots-alive) →
 *     rollback на другой слот/вшитую;
 *   - страница сообщила о падении (slots-crash) → немедленный rollback;
 *   - вшитая связка догнала слоты (version.json) → слоты стираются;
 *   - несовместимость (ui.requiresCoreApi ≠ core.apiVersion,
 *     minShell > вшитого) → слот не активируется.
 * Состояние слотов пишет ТОЛЬКО SW и только после верифицированной
 * установки (staging → слот выполняет сам SW) — кэш слота не может
 * появиться вне проверенного пути.
 */

const SLOTS_STATE_CACHE = "srpski-slot-state";
const SLOTS_STATE_KEY = "/__slots__/state";
const SLOTS_LOG_KEY = "/__slots__/log";
const SLOTS_WATCHDOG_MS = 120000;
const SLOTS_STAGE_UI = "srpski-slot-stage-ui";
const SLOTS_STAGE_CORE = "srpski-slot-stage-core";
const SLOTS_NEVER = /^\/(sw\.js|version\.json|packages\/|baked\.json|__pkg\/|models\/|ort\/|audio\/)/;

function slotUiCache(id) { return "srpski-slot-" + id + "-ui"; }
function slotCoreCache(id) { return "srpski-slot-" + id + "-core"; }

async function slotsState() {
  try {
    const c = await caches.open(SLOTS_STATE_CACHE);
    const r = await c.match(SLOTS_STATE_KEY);
    if (!r) return null;
    const st = await r.json();
    return st && st.v === 1 ? st : null;
  } catch (e2) { return null; }
}

async function saveSlotsState(st) {
  const c = await caches.open(SLOTS_STATE_CACHE);
  await c.put(SLOTS_STATE_KEY, new Response(JSON.stringify(st), {
    headers: { "Content-Type": "application/json" },
  }));
}

async function slotsLog(ev, slot, reason) {
  try {
    const c = await caches.open(SLOTS_STATE_CACHE);
    const r = await c.match(SLOTS_LOG_KEY);
    const log = r ? await r.json() : [];
    log.push({ ts: Date.now(), ev, slot: slot || null, reason: (reason || "").slice(0, 200) });
    while (log.length > 20) log.shift();
    await c.put(SLOTS_LOG_KEY, new Response(JSON.stringify(log), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (e2) {}
}

async function slotsWipe(reason) {
  try {
    await caches.delete(slotUiCache("a")); await caches.delete(slotCoreCache("a"));
    await caches.delete(slotUiCache("b")); await caches.delete(slotCoreCache("b"));
    await caches.delete(SLOTS_STAGE_UI); await caches.delete(SLOTS_STAGE_CORE);
    const c = await caches.open(SLOTS_STATE_CACHE);
    await c.delete(SLOTS_STATE_KEY);
    await slotsLog("wipe", null, reason);
  } catch (e2) {}
}

// Вшитый version.json: fetch изнутри SW не проходит через собственный
// обработчик — это гарантированно baked-файл. Неизвестен (офлайн) → null.
let bakedCodeMemo = { at: 0, code: null };
async function bakedCode() {
  if (Date.now() - bakedCodeMemo.at < 60000) return bakedCodeMemo.code;
  try {
    const r = await fetch("/version.json?slotschk=" + Date.now(), { cache: "no-store" });
    if (!r || !r.ok) return bakedCodeMemo.code;
    const j = await r.json();
    const code = parseInt(j && j.code, 10) || 0;
    if (code > 0) { bakedCodeMemo = { at: Date.now(), code }; }
    return code || bakedCodeMemo.code;
  } catch (e2) { return bakedCodeMemo.code; }
}

// Совместимость связки со вшитой оболочкой и между слоями.
function slotCompatOk(slot, baked) {
  try {
    const ui = slot && slot.ui, core = slot && slot.core;
    if (!ui || !core) return false;
    if (ui.requiresCoreApi !== core.apiVersion) return false;
    if (baked != null) {
      if (typeof core.minShell === "number" && core.minShell > baked) return false;
      if (typeof ui.minShell === "number" && ui.minShell > baked) return false;
    }
    return true;
  } catch (e2) { return false; }
}

// Отметить слот упавшим и переключиться: другой годный слот → он,
// оба плохи → вшитая связка (active = null). Возврат — новый активный id.
async function slotFail(id, reason) {
  const st = await slotsState();
  if (!st) return null;
  st.fails = st.fails || {};
  st.fails[id] = (st.fails[id] || 0) + 1;
  await slotsLog("rollback", id, reason);
  const other = id === "a" ? "b" : "a";
  const baked = await bakedCode();
  const otherOk = st.slots[other] && slotCompatOk(st.slots[other], baked) && (st.fails[other] || 0) < 2;
  st.active = otherOk ? other : null;
  st.confirmed = false;
  st.activatedAt = Date.now();
  await saveSlotsState(st);
  return st.active;
}

// Раздача файлов активного слота. null → вызывающий делает fetch(req)
// (вшитые файлы / легаси hot). Совместимость и сторож — перед каждой навигацией.
async function slotRespond(req) {
  const st = await slotsState();
  if (!st || !st.active) return null;
  const id = st.active;
  const slot = st.slots[id];
  const baked = await bakedCode();
  if (slot && baked != null && baked >= ((slot.ui && slot.ui.code) || 0)) {
    await slotsWipe("baked-newer");
    return null;
  }
  if (!slot || !slotCompatOk(slot, baked)) {
    await slotFail(id, "incompatible");
    return null;
  }
  if (!st.confirmed && Date.now() - (st.activatedAt || 0) > SLOTS_WATCHDOG_MS) {
    await slotFail(id, "watchdog");
    return null;
  }
  const p = new URL(req.url).pathname;
  if (SLOTS_NEVER.test(p)) return null;
  if (p === "/core.js") {
    const coreCache = await caches.open(slotCoreCache(id));
    const m = await coreCache.match(req);
    return m || null;
  }
  const uiCache = await caches.open(slotUiCache(id));
  const isNav = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isNav) {
    const cands = p.endsWith("/") ? [p + "index.html", "/index.html"] : [p, p + ".html", "/index.html"];
    for (let i = 0; i < cands.length; i++) {
      const m = await uiCache.match(cands[i]);
      if (m) return m;
    }
    return null;
  }
  const m = await uiCache.match(req);
  return m || null;
}

/* ---------- Стратегии кэша (v2.28.8) ---------- */

function raceTimeout(p, ms) {
  return new Promise((res) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res(null); } }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(t); res(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); res(null); } });
  });
}

function cacheable(resp) {
  return resp && resp.status === 200 && resp.type === "basic";
}

// v2.35.1: ev (FetchEvent) — если сеть не успела за таймаут и ответ взят из
// кэша, ожидание сети продолжается в фоне; свежий ответ дописывается в кэш
// через ev.waitUntil. Раньше ответ выбрасывался — кэш мог застревать навсегда.
async function networkFirst(req, ms, cacheName, fallbackUrl, ev) {
  const cache = await caches.open(cacheName);
  let raced = false;
  const put = (resp) => {
    if (resp && resp.ok) {
      try { return cache.put(req, resp.clone()); } catch (e) {}
    }
    return Promise.resolve();
  };
  const net = fetch(req).then((resp) => {
    if (raced) {
      const tail = Promise.resolve(put(resp)).catch(() => {});
      try { if (ev && ev.waitUntil) ev.waitUntil(tail); } catch (e) {}
    }
    return resp;
  }).catch(() => null);
  const resp = await raceTimeout(net, ms);
  raced = true;
  if (resp) {
    await put(resp);
    return resp;
  }
  const cached = await cache.match(req);
  if (cached) return cached;
  if (fallbackUrl) {
    const f = await cache.match(fallbackUrl);
    if (f) return f;
  }
  return new Response("offline", { status: 503, statusText: "offline" });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const cached = await cache.match(req);
    if (cached) return cached;
  } catch (e) {}
  try {
    const resp = await fetch(req);
    if (cacheable(resp)) {
      try { await cache.put(req, resp.clone()); } catch (e) {}
    }
    return resp;
  } catch (e) {
    return new Response("offline", { status: 503, statusText: "offline" });
  }
}

async function trimFIFO(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) {
    try { await cache.delete(keys[i]); } catch (e) {}
  }
}

async function cacheFirstTrimmed(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  try {
    const cached = await cache.match(req);
    if (cached) return cached;
  } catch (e) {}
  try {
    const resp = await fetch(req);
    if (cacheable(resp)) {
      try {
        await cache.put(req, resp.clone());
        trimFIFO(cache, max).catch(() => {});
      } catch (e) {}
    }
    return resp;
  } catch (e) {
    return new Response("offline", { status: 503, statusText: "offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  let cached = null;
  try { cached = await cache.match(req); } catch (e) {}
  const refresh = fetch(req).then((resp) => {
    if (cacheable(resp)) {
      try { return cache.put(req, resp.clone()); } catch (e) {}
    }
    return null;
  }).catch(() => null);
  if (cached) return cached;
  await raceTimeout(refresh, 4000);
  try {
    const m = await cache.match(req);
    if (m) return m;
  } catch (e) {}
  return new Response("offline", { status: 503, statusText: "offline" });
}

/* ---------- Жизненный цикл ---------- */

self.addEventListener("install", (e) => {
  if (SHELL_ON) {
    e.waitUntil((async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(SHELL_PRECACHE.map((u) =>
        cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
    })());
  }
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const names = await caches.keys();
      const prefixes = ["srpski-shell-", "srpski-static-", "srpski-media-"];
      await Promise.all(names
        .filter((n) => prefixes.some((p) => n.startsWith(p)))
        .filter((n) => n !== SHELL_CACHE && n !== STATIC_CACHE && n !== MEDIA_CACHE)
        .map((n) => caches.delete(n)));
    } catch (e) {}
    await self.clients.claim();
  })());
});

/* ---------- Маршрутизация ---------- */

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  // 1. (этап 3c.2) Легаси-маршрут /__pkg/<pack>/<file> УДАЛЕН: блобы озвучки
  //    переехали в srpski-langpacks (миграция v4), резолвер играет их
  //    напрямую через ядро; вшитая озвучка доступна по /audio.

  // 2. ASR-модели: пак sr-ru-asr-models в srpski-langpacks; фолбэк —
  //    легаси-блобы (до миграции v4); далее сеть (вшитые full-APK)
  if (p.startsWith("/models/") || p.startsWith("/ort/")) {
    e.respondWith(
      fileOf("packs/sr-ru-asr-models/" + p.slice(1))
        .catch(() => null)
        .then((b) => {
          if (b) return new Response(b, { headers: { "Content-Type": mimeOf(p) } });
          return legacyBlobOf("asr-models|" + p.slice(1)).then((lb) => {
            if (lb) return new Response(lb, { headers: { "Content-Type": mimeOf(p) } });
            return fetch(req);
          });
        })
    );
    return;
  }

  // 2.5. СЛОТЫ A/B (этап 4) + HOT-BUNDLE (легаси, до миграции): нативный
  //      режим — быстрый патч веб-слоя поверх вшитых файлов. Активная
  //      связка слотов раздаётся из слот-кэшей; их нет — прежнее
  //      поведение (легаси hot либо вшитые файлы). Пакеты/модели и
  //      /audio обработаны выше — состояние APK слоты не трогают.
  if (!SHELL_ON) {
    const isNav = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
    if (isNav || p.startsWith("/_next/") || p === "/core.js" || !p.startsWith("/audio/")) {
      // активная связка слотов → файлы слота; иначе легаси hot / вшитые файлы
      e.respondWith(slotRespond(req).then((r) => r || hotRespond(req)));
    }
    return;
  }

  // 3. Нативный APK без hot-ветки: дальше логики v2.21.0 нет — файлы локальны
  if (!SHELL_ON) return;

  // 3.5 №53: core.js — network-first (раньше SWR: после обновления страница
  // получала СТАРЫЙ core.js из STATIC_CACHE, контракты ядра расходились —
  // «Курс не собирается» и вечная «Загружаем пакеты…» в живом профиле).
  if (p === "/core.js") {
    e.respondWith(networkFirst(req, VER_TIMEOUT, STATIC_CACHE, null, e));
    return;
  }

  // 4. Навигации: сеть (таймаут) → кэш → /index.html → офлайн-страница
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(networkFirst(req, NAV_TIMEOUT, SHELL_CACHE, "/index.html", e));
    return;
  }

  // 5. Версия/манифест: сеть с коротким таймаутом → кэш
  if (p === "/version.json" || p === "/manifest.webmanifest") {
    e.respondWith(networkFirst(req, VER_TIMEOUT, SHELL_CACHE, null, e));
    return;
  }

  // 6. Имmutablе-статика Next (контент-хэши): cache-first
  if (p.startsWith("/_next/static/")) {
    e.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // 7. Озвучка фонотеки: cache-first с FIFO-обрезкой (прослушанное — офлайн)
  if (p.startsWith("/audio/")) {
    e.respondWith(cacheFirstTrimmed(req, MEDIA_CACHE, MAX_MEDIA));
    return;
  }

  // 8. Прочее (иконки, шрифты): stale-while-revalidate
  e.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
});

/* ---------- Сообщения клиента (hot-bundle, v2.42.0) ---------- */

self.addEventListener("message", (e) => {
  const d = e.data || {};
  const src = e.source;

  // Активация бандла: файлы уже в кэше (положил клиент), проверяем и пишем
  // состояние. Отвечаем hb-activated — старый SW (до 2.42.0) не ответит,
  // клиент по таймауту откажется применять (защита от несовместимости).
  if (d.type === "hb-activate") {
    e.waitUntil((async () => {
      try {
        const st = d.state || {};
        if (!st.code || !st.version || !st.sha256) throw new Error("неполное состояние");
        const cache = await caches.open(HOT_CACHE);
        const keys = await cache.keys();
        if (keys.length < (d.minFiles || 1)) {
          throw new Error("файлы бандла не доложились: " + keys.length);
        }
        st.activatedAt = Date.now();
        st.confirmed = false;
        st.files = keys.length;
        const sc = await caches.open(HOT_STATE_CACHE);
        await sc.put(HOT_STATE_KEY, new Response(JSON.stringify(st), {
          headers: { "Content-Type": "application/json" },
        }));
        if (src && src.postMessage) src.postMessage({ type: "hb-activated", ok: true });
      } catch (err) {
        await hotClear();
        if (src && src.postMessage) {
          src.postMessage({ type: "hb-activated", ok: false, error: String((err && err.message) || err) });
        }
      }
    })());
    return;
  }

  // Подтверждение успешной загрузки (шлют pkgs-dl.js при инициализации и
  // карточка настроек) — сторож 120 с снимается.
  if (d.type === "hb-confirm") {
    e.waitUntil((async () => {
      try {
        const sc = await caches.open(HOT_STATE_CACHE);
        const r = await sc.match(HOT_STATE_KEY);
        if (!r) return;
        const st = await r.json();
        if (st.confirmed) return;
        st.confirmed = true;
        await sc.put(HOT_STATE_KEY, new Response(JSON.stringify(st), {
          headers: { "Content-Type": "application/json" },
        }));
      } catch (e2) {}
    })());
    return;
  }

  // Текущее состояние (для карточки и SUPD)
  if (d.type === "hb-get") {
    (async () => {
      const st = await hotState();
      if (src && src.postMessage) src.postMessage({ type: "hb-state", state: st });
    })();
    return;
  }

  // Ручной сброс (кнопка в настройках)
  if (d.type === "hb-reset") {
    e.waitUntil(hotClear().then(() => {
      if (src && src.postMessage) src.postMessage({ type: "hb-reset-done" });
    }));
    return;
  }

  /* ---------- СЛОТЫ A/B (этап 4) ---------- */

  // Активация верифицированной связки: клиент скачал core/ui, проверил
  // sha256 каждого файла, подписи ed25519 и совместимость, положил файлы
  // в staging-кэши. SW перепроверяет структуры/совместимость/число файлов,
  // ПЕРЕНОСИТ staging в свободный слот и переключает активный.
  // Состояние слотов пишется только здесь — вне этого пути кэш слота
  // не появляется.
  if (d.type === "slots-activate") {
    e.waitUntil((async () => {
      const reply = (ok, error) => {
        if (src && src.postMessage) src.postMessage({ type: "slots-activated", ok, error: error || undefined });
      };
      try {
        const ui = d.ui, core = d.core;
        if (!ui || !core || ui.layer !== "ui" || core.layer !== "core") throw new Error("манифесты слоёв неполные");
        if (!ui.code || !ui.version || !core.code || !core.version) throw new Error("в манифестах нет версии/кода");
        if (ui.requiresCoreApi !== core.apiVersion) {
          throw new Error("несовместимы: ui требует coreApi " + ui.requiresCoreApi + ", core даёт " + core.apiVersion);
        }
        const baked = await bakedCode();
        if (baked != null) {
          if (typeof core.minShell === "number" && core.minShell > baked) {
            throw new Error("core требует оболочку ≥ " + core.minShell + " (вшита " + baked + ")");
          }
          if (typeof ui.minShell === "number" && ui.minShell > baked) {
            throw new Error("ui требует оболочку ≥ " + ui.minShell + " (вшита " + baked + ")");
          }
          if (ui.code <= baked) throw new Error("связка не новее вшитой");
        }
        const stageUi = await caches.open(SLOTS_STAGE_UI);
        const stageCore = await caches.open(SLOTS_STAGE_CORE);
        const nUi = (await stageUi.keys()).length;
        const nCore = (await stageCore.keys()).length;
        if (nCore < 1) throw new Error("core-слой не доложен в staging");
        if (nUi < Math.min(ui.filesCount || 1, 8)) throw new Error("ui-слой не доложен в staging (" + nUi + " файлов)");
        const st = (await slotsState()) || { v: 1, active: null, confirmed: false, activatedAt: 0, slots: {}, fails: {} };
        const target = st.active === "a" ? "b" : "a"; // активный слот не трогаем
        const uiCache = await caches.open(slotUiCache(target));
        const coreCache = await caches.open(slotCoreCache(target));
        await caches.delete(slotUiCache(target));
        await caches.delete(slotCoreCache(target));
        const uiT = await caches.open(slotUiCache(target));
        const coreT = await caches.open(slotCoreCache(target));
        for (const r of await stageUi.keys()) { const resp = await stageUi.match(r); await uiT.put(r, resp); }
        for (const r of await stageCore.keys()) { const resp = await stageCore.match(r); await coreT.put(r, resp); }
        st.slots = st.slots || {};
        st.slots[target] = { ui, core, at: Date.now() };
        st.active = target;
        st.confirmed = false;
        st.activatedAt = Date.now();
        if (st.fails) st.fails[target] = 0;
        await saveSlotsState(st);
        await slotsLog("activate", target, "v" + ui.version + " + core v" + core.version);
        await caches.delete(SLOTS_STAGE_UI);
        await caches.delete(SLOTS_STAGE_CORE);
        await hotClear(); // миграция: легаси hot-кэш больше не нужен
        reply(true);
      } catch (err) {
        await slotsLog("activate-fail", null, String((err && err.message) || err));
        reply(false, String((err && err.message) || err));
      }
    })());
    return;
  }

  // Подтверждение живости UI (после первого успешного рендера): сторож
  // снимается, счётчик провалов слота обнуляется.
  if (d.type === "slots-alive") {
    e.waitUntil((async () => {
      try {
        const st = await slotsState();
        if (!st) return;
        st.confirmed = true;
        if (st.active && st.fails) st.fails[st.active] = 0;
        await saveSlotsState(st);
        await slotsLog("alive", st.active, null);
      } catch (e2) {}
    })());
    return;
  }

  // Немедленный rollback: страница поймала фатальную ошибку при старте.
  if (d.type === "slots-crash") {
    e.waitUntil((async () => {
      const st = await slotsState();
      if (st && st.active) {
        await slotFail(st.active, "crash: " + String(d.reason || "неизвестно"));
        if (src && src.postMessage) src.postMessage({ type: "slots-rolled-back", ok: true });
      }
    })());
    return;
  }

  // Состояние слотов (карточка настроек, диагностика).
  if (d.type === "slots-get") {
    (async () => {
      const st = await slotsState();
      let log = [];
      try {
        const c = await caches.open(SLOTS_STATE_CACHE);
        const r = await c.match(SLOTS_LOG_KEY);
        if (r) log = await r.json();
      } catch (e2) {}
      if (src && src.postMessage) src.postMessage({ type: "slots-state", state: st, log });
    })();
    return;
  }

  // Ручной сброс слотов (кнопка в настройках): вшитая связка.
  if (d.type === "slots-reset") {
    e.waitUntil((async () => {
      await slotsWipe("manual");
      if (src && src.postMessage) src.postMessage({ type: "slots-reset-done" });
    })());
    return;
  }
});
