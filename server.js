// ============================================================
// 远拓运营中心 · 后端服务器
// 一台机器搞定：API + 数据存储 + 图片存储 + 静态网页
// 部署：node server.js  (配置 .env 文件设置 APPID / APPSECRET / ADMIN_OPENID)
//
// 数据持久化（二选一，按是否配置 TCB_ENV 自动切换）：
//   1. 配置 TCB_ENV（CloudBase 环境ID）  →  JSON 数据存云数据库(kv集合)，图片存云存储
//   2. 未配置 TCB_ENV                    →  JSON/图片都存本地磁盘（开发/沙箱/临时用）
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- 加载 .env 文件（无需 dotenv 依赖，手动解析） ----
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const APPID = process.env.APPID || "";
const APPSECRET = process.env.APPSECRET || "";
const ADMIN_OPENID = process.env.ADMIN_OPENID || "";

// ---- CloudBase 初始化（仅在配置了 TCB_ENV 时加载 SDK） ----
let tcb = null;
const TCB_ENV = process.env.TCB_ENV || process.env.ENV_ID || process.env.CLOUDBASE_ENV;
if (TCB_ENV) {
  try {
    const cloudbase = require("@cloudbase/node-sdk");
    const opts = { env: TCB_ENV };
    if (process.env.TCB_API_KEY) {
      // 新版控制台「服务端 API Key」单密钥模式
      opts.apiKey = process.env.TCB_API_KEY;
    } else if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
      // 旧版 SecretId/SecretKey 模式
      opts.secretId = process.env.TCB_SECRET_ID;
      opts.secretKey = process.env.TCB_SECRET_KEY;
    }
    tcb = cloudbase.init(opts);
    console.log(`  ☁️  CloudBase SDK 已加载，环境: ${TCB_ENV}`);
  } catch (e) {
    console.error("  ⚠️  CloudBase 初始化失败，将回退到本地磁盘:", e.message);
    tcb = null;
  }
}

// USE_CLOUD: SDK 是否加载成功；cloudConfirmed: 运行时探测云是否真正可用
// （避免云连不上却硬走云模式导致登录/请求永久卡死）
let USE_CLOUD = !!tcb;
let cloudConfirmed = false;

// 本地目录（云模式探测失败时也会用到）
// 自动检测 dist 目录：优先同级 dist/（部署包），其次 ../standalone/dist（开发环境）
const DIST_DIR = process.env.DIST_DIR ||
  (fs.existsSync(path.join(__dirname, "dist")) ? path.join(__dirname, "dist") : path.join(__dirname, "..", "standalone", "dist"));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SURVEYS_DIR = path.join(DATA_DIR, "surveys");

function ensureLocalDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(SURVEYS_DIR, { recursive: true });
}

// 超时包装：云调用若挂起（既不 resolve 也不 reject）会在 ms 后 reject，避免请求卡死
function withTimeout(p, ms = 5000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("cloud timeout")), ms))]);
}

// 运行时探测：确认云数据库真正可读。探测失败则自动降级本地磁盘，保证服务可用、登录不卡死。
if (USE_CLOUD) {
  ensureLocalDirs(); // 先建好本地目录，降级时立刻可用
  (async () => {
    try {
      await withTimeout(tcb.database().createCollection("kv"), 5000).catch(() => {});
      await withTimeout(tcb.database().collection("kv").doc("__probe__").set({ _probe: true, _updated: Date.now() }), 5000);
      await withTimeout(tcb.database().collection("kv").doc("__probe__").get(), 5000);
      cloudConfirmed = true;
      console.log("  ✅ CloudBase 持久化已确认可用");
    } catch (e) {
      console.warn("  ⚠️  CloudBase 连接失败（" + (e && e.message || e) + "），已自动降级为本地磁盘，请检查 TCB_ENV / 密钥配置");
      USE_CLOUD = false;
    }
  })();
} else {
  ensureLocalDirs();
}

// ---- 内存会话：token -> { openid, name } ----
const sessions = new Map();

// ---- 存储层：JSON 数据（云数据库 kv 集合 / 本地 JSON 文件） ----
async function readJSON(name, fallback) {
  if (!(USE_CLOUD && cloudConfirmed)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8"));
    } catch {
      return fallback;
    }
  }
  try {
    const r = await withTimeout(tcb.database().collection("kv").doc(name).get());
    if (r.data && r.data.length) return r.data[0].value;
  } catch (e) {
    console.error("readJSON", name, e.message);
  }
  return fallback;
}

async function writeJSON(name, data) {
  if (!(USE_CLOUD && cloudConfirmed)) {
    const file = path.join(DATA_DIR, name + ".json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return;
  }
  try {
    await withTimeout(tcb.database().collection("kv").doc(name).set({ value: data, _updated: Date.now() }));
  } catch (e) {
    console.error("writeJSON", name, e.message);
  }
}

// ---- 问卷存储（每个活动一条 kv 记录） ----
async function readSurveys(activityId) {
  return await readJSON("surveys_" + activityId, []);
}

async function appendSurvey(activityId, record) {
  const list = await readSurveys(activityId);
  list.push({ ...record, submittedAt: new Date().toISOString() });
  await writeJSON("surveys_" + activityId, list);
}

// ---- 图片读取（云存储 / 本地磁盘） ----
async function serveCloudFile(rel, res) {
  const files = await readJSON("files", {});
  const fileID = files[rel];
  if (!fileID) return res.status(404).send("not found");
  try {
    const { fileContent } = await withTimeout(tcb.storage().downloadFile({ fileID }));
    res.type(path.extname(rel) || ".bin");
    res.send(fileContent);
  } catch (e) {
    res.status(500).send("download failed: " + e.message);
  }
}

// ---- 中间件 ----
app.use(express.json({ limit: "50mb" }));

// CORS（允许跨域，方便调试）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 上传的图片服务：本地静态始终可用；云模式且已确认可用时优先走云存储
app.use("/uploads", express.static(UPLOADS_DIR));
if (TCB_ENV) {
  app.get("/uploads/*", (req, res, next) => {
    if (!(USE_CLOUD && cloudConfirmed)) return next(); // 云未确认可用，回退本地静态
    serveCloudFile(req.params[0], res);
  });
}

// ---- 鉴权中间件 ----
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.openid = session.openid;
  req.userName = session.name;
  next();
}

async function requireAdmin(req, res, next) {
  if (req.openid === ADMIN_OPENID) return next();
  const users = await readJSON("users", {});
  const u = users[req.openid];
  if (u && u.role === "admin" && u.status === "active") return next();
  res.status(403).json({ error: "forbidden" });
}

// ============================================================
// API 路由
// ============================================================

// ---- 微信登录：code 换 openid + token ----
app.post("/api/auth/login", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "missing code" });
  if (!APPID || !APPSECRET) return res.status(500).json({ error: "server not configured" });

  try {
    const wxUrl =
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${APPID}` +
      `&secret=${APPSECRET}&code=${code}&grant_type=authorization_code`;
    const resp = await fetch(wxUrl);
    const data = await resp.json();
    if (data.errcode) return res.status(400).json({ error: data.errmsg || "wechat error" });

    const { openid } = data;
    const token = crypto.randomBytes(32).toString("hex");
    const name = "同事-" + openid.slice(-4);
    sessions.set(token, { openid, name });
    res.json({ openid, token, name });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// ---- 会话解析：拿当前用户角色/状态 ----
app.get("/api/auth/session", auth, async (req, res) => {
  const openid = req.openid;

  if (!ADMIN_OPENID) {
    return res.json({ needConfig: true, myOpenid: openid });
  }

  const users = await readJSON("users", {});
  const now = new Date().toISOString();

  // 管理员：即使之前被记录为待审核，也强制提升为 active admin
  if (openid === ADMIN_OPENID) {
    const existing = users[openid];
    if (!existing || existing.role !== "admin" || existing.status !== "active") {
      users[openid] = {
        ...existing,
        name: existing?.name || "管理员",
        role: "admin",
        status: "active",
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      await writeJSON("users", users);
    }
    users[openid].lastActiveAt = now;
    await writeJSON("users", users);
    return res.json({ session: { openid, name: users[openid].name, role: "admin", status: "active", lastActiveAt: now } });
  }

  // 普通成员
  if (!users[openid]) {
    users[openid] = {
      name: req.userName || ("同事-" + openid.slice(-4)),
      role: "operator",
      status: "pending",
      createdAt: now,
      lastActiveAt: now,
    };
    await writeJSON("users", users);
    return res.json({ session: { openid, name: users[openid].name, role: "operator", status: "pending", lastActiveAt: now } });
  }

  // 刷新活跃时间
  users[openid].lastActiveAt = now;
  await writeJSON("users", users);

  const u = users[openid];
  res.json({ session: { openid, name: u.name, role: u.role, status: u.status, lastActiveAt: u.lastActiveAt || null } });
});

// ---- 用户列表（管理员） ----
app.get("/api/auth/users", auth, requireAdmin, async (req, res) => {
  const users = await readJSON("users", {});
  const list = Object.entries(users).map(([openid, u]) => ({
    openid, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt || null,
  }));
  res.json({ users: list });
});

// ---- 心跳：记录当前用户活跃时间 ----
app.post("/api/auth/heartbeat", auth, async (req, res) => {
  const openid = req.openid;
  const users = await readJSON("users", {});
  if (users[openid]) {
    users[openid].lastActiveAt = new Date().toISOString();
    await writeJSON("users", users);
  }
  res.json({ ok: true });
});

// ---- 修改用户（管理员） ----
app.patch("/api/auth/users/:openid", auth, requireAdmin, async (req, res) => {
  const { openid } = req.params;
  const { name, role, status } = req.body;
  const users = await readJSON("users", {});
  if (!users[openid]) return res.status(404).json({ error: "user not found" });

  if (name !== undefined) users[openid].name = name;
  if (role !== undefined) users[openid].role = role;
  if (status !== undefined) users[openid].status = status;
  users[openid].updatedAt = new Date().toISOString();
  await writeJSON("users", users);
  res.json({ ok: true });
});

// ---- 移除成员（管理员） ----
app.delete("/api/auth/users/:openid", auth, requireAdmin, async (req, res) => {
  const { openid } = req.params;
  if (openid === ADMIN_OPENID) return res.status(400).json({ error: "cannot remove admin" });
  const users = await readJSON("users", {});
  delete users[openid];
  await writeJSON("users", users);
  res.json({ ok: true });
});

// ---- 活动数据 ----
app.get("/api/activities", auth, async (req, res) => {
  res.json(await readJSON("activities", []));
});

app.post("/api/activities", auth, async (req, res) => {
  await writeJSON("activities", req.body.list || []);
  res.json({ ok: true });
});

// ---- 店铺/问卷配置 ----
app.get("/api/store", auth, async (req, res) => {
  res.json(await readJSON("stores", {}));
});

app.post("/api/store", auth, async (req, res) => {
  await writeJSON("stores", req.body.map || {});
  res.json({ ok: true });
});

// ---- 活动上传数据 ----
app.get("/api/uploads/:activityId", auth, async (req, res) => {
  const uploads = await readJSON("uploads", {});
  res.json(uploads[req.params.activityId] || null);
});

app.post("/api/uploads/:activityId", auth, async (req, res) => {
  const uploads = await readJSON("uploads", {});
  uploads[req.params.activityId] = req.body.uploads;
  await writeJSON("uploads", uploads);
  res.json({ ok: true });
});

// ---- 图片上传（base64 → 云存储 / 本地文件） ----
app.post("/api/upload", auth, async (req, res) => {
  const { base64, name, activityId, kind } = req.body;
  if (!base64) return res.status(400).json({ error: "missing base64" });

  const ext = ((name || "x.jpg").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const filename = `${activityId || "misc"}/${kind || "img"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const data = base64.replace(/^data:[^;]+;base64,/, "");

  // 云存储模式（仅在云已确认可用时；失败则降级本地盘）
  if (USE_CLOUD && cloudConfirmed) {
    try {
      const cloudPath = "uploads/" + filename;
      const ret = await withTimeout(tcb.storage().uploadFile({ cloudPath, fileContent: Buffer.from(data, "base64") }));
      const fileID = ret.fileID || ret;
      const files = await readJSON("files", {});
      files[filename] = fileID;
      await writeJSON("files", files);
      return res.json({ url: "/uploads/" + filename, fileID });
    } catch (e) {
      console.error("cloud upload failed, fallback local:", e.message);
    }
  }

  // 本地磁盘模式
  const filepath = path.join(UPLOADS_DIR, filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, Buffer.from(data, "base64"));
  res.json({ url: "/uploads/" + filename, fileID: "" });
});

// ---- 问卷公开接口（无需登录） ----
app.get("/api/survey/:activityId", async (req, res) => {
  const activities = await readJSON("activities", []);
  const stores = await readJSON("stores", {});
  const activity = activities.find((a) => a.id === req.params.activityId) || null;
  const survey = (activity && stores[activity.id] && stores[activity.id].survey) || [];
  res.json({ activity, survey });
});

app.post("/api/survey/:activityId", async (req, res) => {
  await appendSurvey(req.params.activityId, req.body.record || req.body);
  res.json({ ok: true });
});

// ---- 问卷列表（管理员） ----
app.get("/api/surveys/:activityId", auth, async (req, res) => {
  res.json(await readSurveys(req.params.activityId));
});

// ============================================================
// 数据导出 / 导入（管理员，用于切换存储前的备份与迁移）
// ============================================================
app.get("/api/admin/export", auth, requireAdmin, async (req, res) => {
  try {
    const activities = await readJSON("activities", []);
    const users = await readJSON("users", {});
    const stores = await readJSON("stores", {});
    const uploads = await readJSON("uploads", {});
    const files = await readJSON("files", {});
    const surveys = {};
    for (const a of activities) {
      if (a && a.id) surveys[a.id] = await readJSON("surveys_" + a.id, []);
    }
    res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      mode: USE_CLOUD ? "cloud" : "local",
      data: { activities, users, stores, uploads, files, surveys },
    });
  } catch (e) {
    res.status(500).json({ error: "export failed: " + (e && e.message || e) });
  }
});

app.post("/api/admin/import", auth, requireAdmin, async (req, res) => {
  try {
    const payload = req.body && req.body.data;
    if (!payload || typeof payload !== "object") return res.status(400).json({ error: "missing data" });
    const { activities, users, stores, uploads, files, surveys } = payload;
    if (activities) await writeJSON("activities", activities);
    if (users) await writeJSON("users", users);
    if (stores) await writeJSON("stores", stores);
    if (uploads) await writeJSON("uploads", uploads);
    if (files) await writeJSON("files", files);
    if (surveys && typeof surveys === "object") {
      for (const [aid, list] of Object.entries(surveys)) {
        await writeJSON("surveys_" + aid, list);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "import failed: " + (e && e.message || e) });
  }
});

// ============================================================
// 微信公众号网页授权域名验证
// ============================================================
// 在公众号后台设置「网页授权域名」时，会要求下载 MP_verify_xxx.txt 并放到域名根目录。
// 把该文件的内容填到环境变量 MP_VERIFY_CONTENT，即可通过 /MP_verify_xxx.txt 访问。
app.get("/MP_verify_*.txt", (req, res) => {
  const content = process.env.MP_VERIFY_CONTENT || "";
  if (!content) return res.status(404).type("text/plain").send("MP_VERIFY_CONTENT not configured");
  res.type("text/plain").send(content);
});

// ============================================================
// 静态文件 & SPA 回退
// ============================================================

// 前端构建产物（index.html, survey.html, assets 等）
app.use(express.static(DIST_DIR));

// SPA 回退：非 API 路由返回 index.html
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "not found" });
  }
  res.sendFile(path.join(DIST_DIR, "index.html"), (err) => {
    if (err) res.status(404).send("前端未构建，请先运行 npm run build:standalone");
  });
});

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`\n  远拓运营中心服务器已启动`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  持久化: ${USE_CLOUD ? "CloudBase (云数据库+云存储)" : "本地磁盘"}`);
  if (!APPID || !APPSECRET) console.warn("  ⚠️  未配置 APPID/APPSECRET，微信登录不可用");
  if (!ADMIN_OPENID) console.warn("  ⚠️  未配置 ADMIN_OPENID，首次打开显示「系统未初始化」页面\n");
  else console.log("");
});
