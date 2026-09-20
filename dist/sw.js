/* ============================================================
 * 远拓运营中心 · 冷启动自愈 Service Worker
 * ------------------------------------------------------------
 * 背景：云托管（CloudBase Run）在「低成本」副本模式下，服务空闲约 30 分钟后
 *       会缩容到 0 个实例。此后第一个访客会直接撞上网关返回的
 *       `503 Service Temporarily Unavailable`（nginx 页面），
 *       表现为「后台又打不开了」，刷新一下就好。
 *
 * 本 SW 只做一件事：
 *   同源「只读」请求（GET / HEAD，包含整页导航）遇到网关 5xx 时，
 *   自动延迟重试若干轮，直到容器冷启动完成。
 *   把「打不开」变成「慢 3～8 秒」。
 *
 * 三条硬约束（勿违反）：
 *   1. 不做任何缓存 —— 本项目曾因浏览器吃旧缓存吃过亏，
 *      本 SW 绝不写入 Cache Storage，只重试。
 *   2. 只重试 GET / HEAD —— 写请求（POST/PUT/DELETE）绝不重放，
 *      避免产生重复的报名、保单、费用数据。
 *   3. 任何异常都回落到原生 fetch —— SW 本身不允许成为新的故障点。
 * ============================================================ */

const SW_VERSION = "yuantu-coldstart-sw/2026-09-20.1";

/* 重试间隔（毫秒）。合计约 25 秒，足以覆盖容器冷启动。 */
const RETRY_DELAYS = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000];

/* 视为「网关层故障」的状态码：请求根本没到达应用，重试是安全的。 */
const GATEWAY_ERROR_STATUS = [502, 503, 504];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isReadOnlySameOrigin(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch (err) {
    return false;
  }
}

function isGatewayError(response) {
  return GATEWAY_ERROR_STATUS.indexOf(response.status) !== -1;
}

/* 重试全部失败时，给「整页导航」一个体面页面，而不是 nginx 的裸 503。 */
function warmingPageHtml() {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>',
    "<title>正在唤醒服务 | 远拓运营中心</title>",
    "<style>",
    "html,body{height:100%;margin:0}",
    "body{display:flex;align-items:center;justify-content:center;",
    "background:#0d1117;color:#e6edf3;",
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    ".wrap{text-align:center;padding:32px;max-width:420px}",
    ".ring{width:44px;height:44px;margin:0 auto 22px;border-radius:50%;",
    "border:3px solid rgba(255,255,255,.16);border-top-color:#4c9aff;",
    "animation:spin .9s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    "h1{font-size:17px;font-weight:500;margin:0 0 12px}",
    "p{font-size:13px;line-height:1.7;color:#9aa4b2;margin:0 0 8px}",
    ".sec{margin-top:18px;font-size:13px;color:#6e7681}",
    "</style></head><body>",
    '<div class="wrap">',
    '<div class="ring"></div>',
    "<h1>正在唤醒服务</h1>",
    "<p>后台刚从休眠状态启动，通常 5～10 秒即可完成。</p>",
    "<p>页面正在自动重试，无需手动刷新。</p>",
    '<p class="sec">已等待 <b id="sec">0</b> 秒</p>',
    "</div>",
    "<script>",
    "var t=0,b=document.getElementById('sec');",
    "setInterval(function(){t++;b.textContent=t;",
    "if(t>=3&&t%3===0)location.reload();},1000);",
    "<\/script>",
    "</body></html>",
  ].join("");
}

function warmingResponse() {
  return new Response(warmingPageHtml(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}

async function fetchWithRetry(request) {
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(request);

      /* 正常响应（含 4xx 业务错误）一律原样放行，不干预业务逻辑。 */
      if (!isGatewayError(response)) return response;

      lastResponse = response;
      lastError = null;
    } catch (err) {
      /* 网络层异常（离线、DNS 失败…），与不加 SW 时表现一致。 */
      lastError = err;
      lastResponse = null;
    }

    if (attempt === RETRY_DELAYS.length) break;
    await sleep(RETRY_DELAYS[attempt]);
  }

  if (lastResponse) {
    /* 整页导航到最后仍失败 → 给「正在唤醒」页，用户不会看到裸 503。 */
    if (request.mode === "navigate") return warmingResponse();
    return lastResponse;
  }
  throw lastError || new Error("request failed");
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (!isReadOnlySameOrigin(request)) return;

  event.respondWith(
    fetchWithRetry(request).catch(() => fetch(request))
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "yuantu:sw-version" && event.source) {
    event.source.postMessage({ type: "yuantu:sw-version", version: SW_VERSION });
  }
});
