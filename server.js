// ============================================================
// 远拓运营中心 · 后端服务器
// 一台机器搞定：API + 数据存储 + 图片存储 + 静态网页
// 部署：node server.js  (配置 .env 文件设置 APPID / APPSECRET / ADMIN_OPENID)
//
// 数据持久化（按环境自动切换，优先顺序）：
//   1. 配置 TCB_ENV + SecretId/SecretKey  →  优先 CloudBase 文档型数据库 (kv集合)
//   2. 文档型数据库不可用 (PG 模式/个人版) →  降级 CloudBase PostgreSQL (manager-node 执行 SQL)
//   3. 未配置 TCB_ENV 或 探测全部失败     →  JSON/图片都存本地磁盘
// ============================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 全局兜底：避免云 SDK 内部未处理的 Promise 拒绝 / 异常导致进程退出、容器反复重启。
// 任何未被捕获的 rejection/异常只记录日志，服务继续运行（若已降级则走本地磁盘），不崩溃。
process.on("unhandledRejection", (reason) => {
  console.error("  ⚠️  [unhandledRejection] 已忽略，避免进程崩溃:", (reason && (reason.message || reason)) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("  ⚠️  [uncaughtException] 已忽略，避免进程崩溃:", (err && err.message) || err);
});

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

// ---- 环境变量与凭证 ----
const TCB_ENV = process.env.TCB_ENV || process.env.ENV_ID || process.env.CLOUDBASE_ENV;
const HAS_TCB_API_KEY = !!process.env.TCB_API_KEY;
const HAS_TCB_SECRET = !!(process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY);

// ---- CloudBase 初始化（仅在配置了 TCB_ENV 时加载 SDK） ----
let tcb = null;
let CLOUDBASE_SDK_VERSION = null;
if (TCB_ENV) {
  try {
    const cloudbase = require("@cloudbase/node-sdk");
    try { CLOUDBASE_SDK_VERSION = require("@cloudbase/node-sdk/package.json").version; } catch {}
    const opts = { env: TCB_ENV };
    if (process.env.TCB_API_KEY) {
      // 新版控制台「服务端 API Key」单密钥模式（SDK 字段名为 accessKey）
      opts.accessKey = process.env.TCB_API_KEY;
    } else if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
      // 旧版 SecretId/SecretKey 模式
      opts.secretId = process.env.TCB_SECRET_ID;
      opts.secretKey = process.env.TCB_SECRET_KEY;
    }
    tcb = cloudbase.init(opts);
    console.log(`  ☁️  CloudBase SDK 已加载 (v${CLOUDBASE_SDK_VERSION})，环境: ${TCB_ENV}`);
  } catch (e) {
    console.error("  ⚠️  CloudBase 初始化失败，将回退到本地磁盘:", e.message);
    tcb = null;
  }
}

// ---- CloudBase 管理端 SDK（用于 PG 模式执行 SQL；仅当有云环境+Secret 时初始化） ----
let manager = null;
let MANAGER_SDK_VERSION = null;
if (TCB_ENV && HAS_TCB_SECRET) {
  try {
    const CloudBase = require("@cloudbase/manager-node");
    try { MANAGER_SDK_VERSION = require("@cloudbase/manager-node/package.json").version; } catch {}
    manager = CloudBase.init({
      secretId: process.env.TCB_SECRET_ID,
      secretKey: process.env.TCB_SECRET_KEY,
      envId: TCB_ENV,
    });
    console.log(`  🗄️  CloudBase Manager SDK 已加载 (v${MANAGER_SDK_VERSION})`);
  } catch (e) {
    console.error("  ⚠️  CloudBase Manager 初始化失败:", e.message);
    manager = null;
  }
}

// USE_CLOUD: 是否尝试走云；cloudConfirmed: 运行时探测云是否真正可用
// CLOUD_MODE: "tcb-db" | "tcb-pg" | null（null 表示本地磁盘）
let USE_CLOUD = !!(tcb || manager);
let cloudConfirmed = false;
let CLOUD_MODE = null;

// 若配置了 TCB_ENV 却无任何可用凭证，直接降级本地磁盘，避免云调用崩溃进程。
if (USE_CLOUD && !HAS_TCB_API_KEY && !HAS_TCB_SECRET) {
  console.warn("  ⚠️  已设置 TCB_ENV 但未提供 TCB_API_KEY / TCB_SECRET_ID+TCB_SECRET_KEY，已回退本地磁盘。");
  USE_CLOUD = false;
  tcb = null;
  manager = null;
}

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
function withTimeout(p, ms = 10000, label = "") {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("cloud timeout" + (label ? " (" + label + ")" : ""))), ms)),
  ]);
}

// ---- PostgreSQL 模式辅助函数 ----
const PG_TABLE = process.env.TCB_PG_TABLE || "yuantu_kv";
async function pgEnsureTable() {
  if (!manager || !manager.database || !manager.database.executePGSql) throw new Error("manager not ready");
  await withTimeout(
    manager.database.executePGSql({
      Sql: `CREATE TABLE IF NOT EXISTS ${PG_TABLE} (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`,
    }),
    15000,
    "pg-create-table"
  );
}
async function pgRead(key) {
  const res = await withTimeout(
    manager.database.executePGSql({ Sql: `SELECT value FROM ${PG_TABLE} WHERE key = '${key.replace(/'/g, "''")}'` }),
    15000,
    "pg-read"
  );
  if (!res || !res.Rows || !res.Rows.length) return undefined;
  const row = JSON.parse(res.Rows[0]);
  // Rows 是字符串数组， Columns 为 ['value']，所以 row[0] 是 value 的 JSON 字符串
  const valStr = row[0];
  return typeof valStr === "string" ? JSON.parse(valStr) : valStr;
}
async function pgWrite(key, value) {
  const val = JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "''");
  await withTimeout(
    manager.database.executePGSql({
      Sql: `INSERT INTO ${PG_TABLE} (key, value, updated_at) VALUES ('${key.replace(/'/g, "''")}', '${val}'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    }),
    15000,
    "pg-write"
  );
}

// ---- 图片存 PostgreSQL（PG 模式下云存储 tcb.storage 不可用，改用 PG 文本列存 base64） ----
const PG_FILES_TABLE = process.env.TCB_PG_FILES_TABLE || "yuantu_files";
async function pgEnsureFilesTable() {
  if (!manager || !manager.database || !manager.database.executePGSql) throw new Error("manager not ready");
  await withTimeout(
    manager.database.executePGSql({
      Sql: `CREATE TABLE IF NOT EXISTS ${PG_FILES_TABLE} (key TEXT PRIMARY KEY, content_text TEXT NOT NULL, content_type TEXT, updated_at TIMESTAMP DEFAULT NOW())`,
    }),
    15000,
    "pg-create-files-table"
  );
}
async function pgPutFile(key, buf, contentType) {
  const b64 = buf.toString("base64").replace(/\n/g, "").replace(/'/g, "''");
  const ct = (contentType || "application/octet-stream").replace(/'/g, "''");
  const k = key.replace(/'/g, "''");
  await withTimeout(
    manager.database.executePGSql({
      Sql: `INSERT INTO ${PG_FILES_TABLE} (key, content_text, content_type, updated_at) VALUES ('${k}', '${b64}', '${ct}', NOW()) ON CONFLICT (key) DO UPDATE SET content_text = EXCLUDED.content_text, content_type = EXCLUDED.content_type, updated_at = NOW()`,
    }),
    20000,
    "pg-put-file"
  );
}
async function pgGetFile(key) {
  const res = await withTimeout(
    manager.database.executePGSql({ Sql: `SELECT content_text, content_type FROM ${PG_FILES_TABLE} WHERE key = '${key.replace(/'/g, "''")}'` }),
    15000,
    "pg-get-file"
  );
  if (!res || !res.Rows || !res.Rows.length) return null;
  const row = JSON.parse(res.Rows[0]);
  const b64 = row[0];
  const contentType = row[1] || null;
  if (!b64) return null;
  return { content: Buffer.from(b64, "base64"), content_type: contentType };
}

// 运行时探测：按顺序尝试文档型数据库 → PostgreSQL。失败则自动降级本地磁盘。
let lastCloudError = null;
let lastCloudErrorAt = null;

// 云存储可用性探测（仅云持久化已确认时执行）。失败则图片走本地磁盘，不影响主服务。
let storageConfirmed = false;
let lastStorageError = null;
let lastStorageErrorAt = null;
async function probeStorage() {
  if (!tcb) return;
  try {
    const cloudPath = "__probe__/stest.txt";
    const buf = Buffer.from("probe");
    const ret = await withTimeout(tcb.storage().uploadFile({ cloudPath, fileContent: buf }), 12000, "storage-upload");
    const fileID = ret && ret.fileID;
    if (!fileID) throw new Error("storage upload 返回的 fileID 为空");
    const dl = await withTimeout(tcb.storage().downloadFile({ fileID }), 12000, "storage-download");
    if (!dl || !dl.fileContent) throw new Error("storage download 返回为空");
    await withTimeout(tcb.storage().deleteFile({ fileList: [fileID] }), 12000, "storage-delete").catch(() => {});
    storageConfirmed = true;
    console.log("  ✅ CloudBase 云存储已确认可用（图片将持久化到云）");
  } catch (e) {
    lastStorageError = (e && e.message) || String(e);
    lastStorageErrorAt = new Date().toISOString();
    console.warn("  ⚠️  CloudBase 云存储探测失败（" + lastStorageError + "），图片将走本地磁盘");
  }
}

if (USE_CLOUD) {
  ensureLocalDirs(); // 先建好本地目录，降级时立刻可用
  (async () => {
    // 1) 先探测文档型数据库
    if (tcb) {
      try {
        await withTimeout(tcb.database().createCollection("kv"), 10000, "createCollection").catch(() => {});
        await withTimeout(tcb.database().collection("kv").doc("__probe__").set({ _probe: true, _updated: Date.now() }), 10000, "set");
        await withTimeout(tcb.database().collection("kv").doc("__probe__").get(), 10000, "get");
        cloudConfirmed = true;
        CLOUD_MODE = "tcb-db";
        console.log("  ✅ CloudBase 文档型数据库持久化已确认可用");
        await probeStorage();
        return;
      } catch (e) {
        const msg = ((e && e.message) || String(e)).toLowerCase();
        lastCloudError = (e && e.message) || String(e);
        lastCloudErrorAt = new Date().toISOString();
        console.warn("  ⚠️  CloudBase 文档型数据库探测失败（" + lastCloudError + "），尝试 PostgreSQL 模式...");
        // 如果不是"资源不存在"类错误，且没有 manager，则直接降级
        const isMissingResource = msg.includes("not found") || msg.includes("resource") || msg.includes("数据库") || msg.includes("database");
        if (!isMissingResource || !manager) {
          USE_CLOUD = false;
          return;
        }
      }
    }

    // 2) 文档型数据库不可用，尝试 PostgreSQL（PG 模式 / 个人版常见）
    if (manager) {
      try {
        await pgEnsureTable();
        await pgEnsureFilesTable();
        await pgWrite("__probe__", { _probe: true, _updated: Date.now() });
        const probe = await pgRead("__probe__");
        if (probe && probe._probe) {
          cloudConfirmed = true;
          CLOUD_MODE = "tcb-pg";
          console.log("  ✅ CloudBase PostgreSQL 持久化已确认可用");
          await probeStorage();
          return;
        }
        throw new Error("pg probe read mismatch");
      } catch (e) {
        lastCloudError = (e && e.message) || String(e);
        lastCloudErrorAt = new Date().toISOString();
        console.warn("  ⚠️  CloudBase PostgreSQL 探测失败（" + lastCloudError + "），已自动降级为本地磁盘");
        USE_CLOUD = false;
      }
    }
  })().catch((e) => {
    lastCloudError = (e && e.message) || String(e);
    lastCloudErrorAt = new Date().toISOString();
    console.error("  ⚠️  云探测未捕获异常（已忽略，服务以本地磁盘运行）:", lastCloudError);
    USE_CLOUD = false;
  });
} else {
  ensureLocalDirs();
}

// ---- 内存会话：token -> { openid, name } ----
const sessions = new Map();

// ---- 存储层：JSON 数据（云数据库 kv 集合 / PostgreSQL / 本地 JSON 文件） ----
async function readJSON(name, fallback) {
  if (USE_CLOUD && cloudConfirmed) {
    try {
      if (CLOUD_MODE === "tcb-db") {
        const r = await withTimeout(tcb.database().collection("kv").doc(name).get(), 15000, "db-read");
        if (r.data && r.data.length) return r.data[0].value;
      } else if (CLOUD_MODE === "tcb-pg") {
        const v = await pgRead(name);
        if (v !== undefined) return v;
      }
    } catch (e) {
      console.error("readJSON cloud", name, CLOUD_MODE, e.message);
    }
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJSON(name, data) {
  if (USE_CLOUD && cloudConfirmed) {
    try {
      if (CLOUD_MODE === "tcb-db") {
        await withTimeout(tcb.database().collection("kv").doc(name).set({ value: data, _updated: Date.now() }), 15000, "db-write");
        return;
      } else if (CLOUD_MODE === "tcb-pg") {
        await pgWrite(name, data);
        return;
      }
    } catch (e) {
      console.error("writeJSON cloud", name, CLOUD_MODE, e.message);
    }
    return;
  }
  const file = path.join(DATA_DIR, name + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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

// 上传的图片服务：云存储（PG 模式 / 经典模式）优先，本地磁盘兜底
app.get("/uploads/*", async (req, res) => {
  const rel = req.params[0];
  // 1) PG 模式：从 PostgreSQL 读图片（base64 解码）
  if (USE_CLOUD && cloudConfirmed && CLOUD_MODE === "tcb-pg") {
    try {
      const f = await pgGetFile(rel);
      if (f && f.content && f.content.length) {
        res.type(f.content_type || path.extname(rel) || ".jpg");
        return res.send(f.content);
      }
    } catch (e) { console.error("pg file read", rel, e.message); }
  }
  // 2) 经典模式云存储（fileID 映射）
  if (USE_CLOUD && cloudConfirmed && storageConfirmed) {
    return serveCloudFile(rel, res);
  }
  // 3) 本地磁盘兜底
  const localPath = path.join(UPLOADS_DIR, rel);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    return res.sendFile(localPath);
  }
  res.status(404).send("not found");
});

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

// 健康检查（无需登录）：暴露当前存储模式，便于外部验证云持久化是否生效
function maskVal(v) {
  if (!v) return null;
  if (v.length <= 8) return v;
  return v.slice(0, 4) + "…" + v.slice(-4);
}
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    tcbEnv: !!TCB_ENV,
    tcbEnvValue: maskVal(TCB_ENV),
    mode: (USE_CLOUD && cloudConfirmed) ? "cloud" : "local",
    cloudMode: CLOUD_MODE,
    cloudConfirmed,
    storageConfirmed,
    storageError: lastStorageError,
    storageErrorAt: lastStorageErrorAt,
    sdkVersion: CLOUDBASE_SDK_VERSION,
    managerVersion: MANAGER_SDK_VERSION,
    hasApiKey: HAS_TCB_API_KEY,
    hasSecret: HAS_TCB_SECRET,
    lastCloudError,
    lastCloudErrorAt,
  });
});


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

// ---- 图片上传（base64 → PostgreSQL / 经典云存储 / 本地文件） ----
app.post("/api/upload", auth, async (req, res) => {
  const { base64, name, activityId, kind } = req.body;
  if (!base64) return res.status(400).json({ error: "missing base64" });

  const ext = ((name || "x.jpg").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const filename = `${activityId || "misc"}/${kind || "img"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ""), "base64");

  // 1) PG 模式：图片直接存 PostgreSQL（云存储 tcb.storage 在 PG 模式下不可用）
  if (USE_CLOUD && cloudConfirmed && CLOUD_MODE === "tcb-pg") {
    try {
      await pgPutFile(filename, buf, "image/" + ext);
      return res.json({ url: "/uploads/" + filename, fileID: "" });
    } catch (e) {
      console.error("pg file write failed, fallback local:", e.message);
    }
  }
  // 2) 经典模式云存储（fileID 映射）
  if (USE_CLOUD && cloudConfirmed && storageConfirmed) {
    try {
      const cloudPath = "uploads/" + filename;
      const ret = await withTimeout(tcb.storage().uploadFile({ cloudPath, fileContent: buf }), 12000, "storage-upload");
      const fileID = ret.fileID || ret;
      const files = await readJSON("files", {});
      files[filename] = fileID;
      await writeJSON("files", files);
      return res.json({ url: "/uploads/" + filename, fileID });
    } catch (e) {
      console.error("cloud upload failed, fallback local:", e.message);
    }
  }
  // 3) 本地磁盘兜底
  const filepath = path.join(UPLOADS_DIR, filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buf);
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
