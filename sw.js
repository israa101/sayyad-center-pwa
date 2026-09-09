/**
 * sw.js
 * -------------------------------------------------------------
 * Service Worker for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/manifest/icons/fonts): cache-first,
 *     falling back to network, so the app is 100% usable offline
 *     after the first visit.
 *   - Navigation requests: network-first with cache fallback, so
 *     users always get the freshest shell when online, but still
 *     get a working app when offline.
 *   - Everything else (e.g. any future API GETs): network-first
 *     with cache fallback.
 *
 * *** UPDATE FIX (مهم) ***
 * قبل كده كان CACHE_VERSION رقم ثابت بتعدّله يدويًا كل مرة تعمل ديبلوي،
 * ولو نسيت تغيّره، الملفات القديمة (app.js/db.js/index.html) تفضل
 * متخزّنة في الكاش وميتحدّثوش على أجهزة تانية أبدًا، لأن كل ديبلوي
 * بيستخدم نفس اسم الكاش القديم فمفيش تحديث بيتفعّل.
 *
 * ⚠️ تصحيح مهم (مراجعة لاحقة): المتصفح بيقارن bytes ملف sw.js نفسه
 * بس — مش بيراقب app.js/db.js تلقائيًا. يعني تعديل منطقي في app.js من
 * غير أي تغيير في sw.js **مش هيتلاحظ خالص**، وworkers القدامى هيفضلوا
 * يكافلوا app.js القديم من الكاش (cache-first) للأبد.
 *
 * القاعدة العملية: **أي ديبلوي فيه تعديل حقيقي في app.js أو db.js أو
 * أي ملف تاني داخل APP_SHELL_URLS لازم يترافق مع تغيير CACHE_VERSION
 * هنا** (حتى لو رقم تعسفي زي زيادة +0.0.1) — من غير كده، الملفات
 * الجديدة مش هتوصل لأي جهاز تاني أبدًا، وستفضل الأجهزة شغالة بكود قديم
 * للأبد من غير أي تنبيه. لما CACHE_VERSION يتغيّر، الأجهزة كلها (حتى
 * القديمة جدًا اللي معندهاش نظام الـ reload الإجباري في app.js) هتكتشف
 * التحديث وتحمّله في الخلفية تلقائيًا (خلال ساعة كحد أقصى، أو فورًا عند
 * فتح التطبيق/عودة النت)، من غير ما حد يمسح أي حاجة يدويًا.
 * -------------------------------------------------------------
 */

const CACHE_VERSION = 'v1.3.1';
const STATIC_CACHE = `sayyad-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `sayyad-runtime-${CACHE_VERSION}`;

const APP_SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Tajawal:wght@400;500;700;900&display=swap',
];

/* ------------------------------------------------------------ */
/* INSTALL — pre-cache the full app shell                        */
/* ------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Cache each URL individually so a single failure (e.g. a
        // font CDN hiccup) doesn't block the whole install.
        return Promise.all(
          APP_SHELL_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] تعذّر تخزين', url, err);
            })
          )
        );
      })
    // *** UPDATE FIX: ما بنعملش skipWaiting() هنا تلقائيًا. النسخة
    // الجديدة بتفضل "waiting" لحد ما app.js يبعتلها رسالة SKIP_WAITING
    // (عن طريق registerServiceWorker في app.js)، وده بيضمن إن التبديل
    // للنسخة الجديدة بيحصل في لحظة متحكّم فيها مع reload فوري، مش
    // بيتفعّل من غير ما حد يلاحظ ومن غير ريفريش للصفحة. ***
  );
});

/* ------------------------------------------------------------ */
/* ACTIVATE — clean up old cache versions                        */
/* ------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------ */
/* FETCH — routing strategies                                    */
/* ------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests; let POST (e.g. API sync calls) pass through
  // untouched so they hit the network directly and fail/succeed naturally.
  if (request.method !== 'GET' || request.url.includes('supabase.co')) return;

  const url = new URL(request.url);

  // Navigation requests (loading the app itself) -> network-first.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Same-origin static assets -> cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Cross-origin (fonts, CDN) -> cache-first as well, since these rarely
  // change and offline support matters more than freshness here.
  event.respondWith(cacheFirst(request));
});

/* ------------------------------------------------------------ */
/* STRATEGIES                                                     */
/* ------------------------------------------------------------ */

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Last resort: if it's a navigation, serve the cached shell.
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
    return new Response('لا يوجد اتصال بالإنترنت ولا توجد نسخة مخزنة مؤقتًا.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
    return new Response('لا يوجد اتصال بالإنترنت ولا توجد نسخة مخزنة مؤقتًا.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/* ------------------------------------------------------------ */
/* BACKGROUND SYNC (progressive enhancement)                     */
/* ------------------------------------------------------------ */
// The main sync loop lives in app.js (interval + online-event based) so it
// works consistently across all browsers. This listener is an optional
// enhancement for browsers that support the Background Sync API — it just
// notifies open app windows to run the sync routine immediately.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sayyad-sync-queue') {
    event.waitUntil(notifyClientsToSync());
  }
});

async function notifyClientsToSync() {
  const clientsList = await self.clients.matchAll({ type: 'window' });
  clientsList.forEach((client) => {
    client.postMessage({ type: 'SAYYAD_TRIGGER_SYNC' });
  });
}

/* ------------------------------------------------------------ */
/* MESSAGE — allow the page to force-update the SW immediately   */
/* ------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
