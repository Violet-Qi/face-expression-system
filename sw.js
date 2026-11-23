/* ============================================================
   Service Worker —— 让「千颜万花」可以装到桌面、断网也能用
   ------------------------------------------------------------
   为什么要它：
     没有 SW 的网页，断网就白屏。有了它，第一次访问时把核心文件
     存进本地 Cache Storage，以后直接从本地读，不需要联网。

     这正好把这个项目「照片不出本机」的隐私承诺推到极致：
     **装好之后，拔了网线也能完整使用。**

   缓存分三级（关键设计）：
     ① 核心层（安装时缓存，约 10 MB）
        HTML / CSS / JS / 基础模型（tiny detector + tiny landmark + expression）
        —— 保证了「打开就能识别」，断网可用
     ② 按需层（用到才缓存，不预下载）
        SSD 检测器 5.4 MB / 完整关键点 348 KB / FERPlus 18.4 MB / onnx 运行时 10.6 MB
        —— 不选这些档位的用户不付体积代价
     ③ 不缓存层
        /api/* —— 接口数据必须实时，缓存会导致登录态错乱
        /data/* —— 安全，绝不能进缓存

   更新策略（这里踩过坑，必须谨慎）：
     1.7.3 那次因为版本号没升，浏览器用了旧 CSS，导致线上改了却没生效。
     SW 的缓存比浏览器缓存更顽固，所以这里：
       · CACHE_VERSION 每次发版必须改
       · activate 时删掉所有旧版本缓存
       · 页面提供「检查更新」入口（settings 里的按钮）
       · 用 skipWaiting + clients.claim 让新 SW 立即接管
   ============================================================ */

/* ⚠️ 每次发版必须改这里的序号（p)-N 递增；它和 index.html 的 ?v= 是两个概念：
      ?v= 管单个文件的缓存键，CACHE_VERSION 管整个 SW 缓存代际。格式不必相同。 */
/* 显示名 v1.9 Next；缓存令牌用无空格的 1.9next（空格在 URL/cache key 里会变成 %20） */
const CACHE_VERSION = 'v1.9next(p)-6';
const CACHE_NAME = 'qianyan-' + CACHE_VERSION;

/* ① 核心层：安装时就要缓存好的（约 10 MB） */
const CORE_ASSETS = [
  './',
  './index.html',
  './admin.html',
  './manifest.json',
  './css/style.css',
  './css/features.css',
  './css/admin.css',
  './assets/logo.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-180.png',
  './assets/icon-32.png',

  /* 基础 JS —— 缺一个页面就打不开 */
  './js/config.js',
  './js/smoothing.js',
  './js/ripple.js',
  './js/changelog.js',
  './js/model-registry.js',
  './js/expression-engine.js',
  './js/auth.js',
  './js/settings.js',
  './js/diagnostics.js',
  './js/models.js',
  './js/render.js',
  './js/report.js',
  './js/image-select.js',
  './js/recognize.js',
  './js/camera.js',
  './js/video.js',
  './js/stats-trend.js',
  './js/grouping.js',
  './js/main.js',
  './js/admin.js',
  './js/appear-motion.js',
  './js/pwa.js',
  './js/cascade-engine.js',
  './js/cascade-view.js',

  /* 推理引擎本体 */
  './lib/face-api.js',

  /* 基础模型（速度档用的三个，合计约 0.56 MB） */
  './models/tiny_face_detector_model-weights_manifest.json',
  './models/tiny_face_detector_model.bin',
  './models/face_landmark_68_tiny_model-weights_manifest.json',
  './models/face_landmark_68_tiny_model.bin',
  './models/face_expression_model-weights_manifest.json',
  './models/face_expression_model.bin',

  /* 示例图（点「用示例图片」要用） */
  './samples/test-face.jpg'
];

/* ② 按需层：不预缓存，但命中后缓存起来（下次离线可用） */
const LAZY_PATTERNS = [
  /\/models\/ssd_mobilenetv1_model/,
  /\/models\/face_landmark_68_model/,
  /\/models\/face_recognition_model/,
  /\/models\/emotion-ferplus/,
  /\/lib\/onnxruntime\//,
  /\/samples\//
];

/* ③ 永不缓存 */
const NEVER_CACHE = [
  /\/api\//,
  /\/data\//,
  /\/server-app\.js/,
  /\/seed-demo-data\.js/
];

/* ---------------- 安装：预缓存核心层 ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    /* 逐个缓存而不是 addAll：
       addAll 是原子的 —— 只要有一个文件 404，整批都会失败，SW 就装不上。
       逐个缓存的话，个别文件失败不影响整体（比如某张示例图被删了）。 */
    const results = await Promise.allSettled(
      CORE_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
          return { url, ok: res.ok };
        } catch (e) {
          return { url, ok: false, err: String(e) };
        }
      })
    );

    const failed = results.filter(r => r.status === 'fulfilled' && !r.value.ok);
    if (failed.length) {
      console.warn('[SW] 部分核心文件缓存失败（不影响整体）:',
        failed.map(f => f.value.url));
    }

    // 立即接管，不等用户关掉所有标签页
    await self.skipWaiting();
  })());
});

/* ---------------- 激活：清掉旧版本缓存 ---------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('qianyan-') && n !== CACHE_NAME)
        .map(n => {
          console.log('[SW] 删除旧缓存:', n);
          return caches.delete(n);
        })
    );
    // 立即接管所有已打开的页面
    await self.clients.claim();
  })());
});

/* ---------------- 请求拦截 ---------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  const path = url.pathname + url.search;

  /* ③ 永不缓存的：直接走网络 */
  if (NEVER_CACHE.some(re => re.test(path))) {
    return;   // 不拦截，浏览器默认行为
  }

  /* 页面导航请求：网络优先，失败回落到缓存的 index.html
     —— 这样能保证用户总是拿到最新页面，同时断网也能开 */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // 顺手更新缓存
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req) || await cache.match('./index.html');
        return cached || new Response('离线且无缓存', { status: 503 });
      }
    })());
    return;
  }

  /* ② 按需层：缓存优先，没有再联网并顺手存起来 */
  if (LAZY_PATTERNS.some(re => re.test(path))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;

      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        return new Response('离线且未缓存', { status: 503 });
      }
    })());
    return;
  }

  /* ① 核心层：缓存优先（这些文件带 ?v= 版本号，改了就是新 URL，不会读到旧的） */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch (e) {
      const fallback = await cache.match(req, { ignoreSearch: true });
      return fallback || new Response('离线且无缓存', { status: 503 });
    }
  })());
});

/* ---------------- 与页面通信 ---------------- */

self.addEventListener('message', (event) => {
  const data = event.data || {};

  /* 页面主动要求检查更新 */
  if (data.type === 'CHECK_UPDATE') {
    self.registration.update()
      .then(() => {
        if (event.source) event.source.postMessage({ type: 'UPDATE_CHECKED' });
      })
      .catch(() => {
        if (event.source) event.source.postMessage({ type: 'UPDATE_FAILED' });
      });
  }

  /* 页面要求跳过等待，立即用新版本 */
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  /* 页面查询当前缓存了多少东西（用于「离线可用」提示） */
  if (data.type === 'CACHE_STATUS') {
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      let bytes = 0;
      for (const k of keys) {
        const res = await cache.match(k);
        if (res) {
          const blob = await res.clone().blob();
          bytes += blob.size;
        }
      }
      if (event.source) {
        event.source.postMessage({
          type: 'CACHE_STATUS_RESULT',
          count: keys.length,
          bytes: bytes
        });
      }
    })();
  }
});
