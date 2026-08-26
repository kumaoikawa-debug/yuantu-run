// ============================================================
// 远拓运营中心 · 后端服务器
// 一台机器搞定：API + 数据存储 + 图片存储 + 静态网页
// 部署：node server.js  (配置 .env 文件设置 APPID / APPSECRET / ADMIN_OPENID)
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

// ---- 目录 ----
// 自动检测 dist 目录：优先同级 dist/（部署包），其次 ../standalone/dist（开发环境）
const DIST_DIR = process.env.DIST_DIR ||
  (fs.existsSync(path.join(__dirname, "dist")) ? path.join(__dirname, "dist") : path.join(__dirname, "..", "standalone", "dist"));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SURVEYS_DIR = path.join(DATA_DIR, "surveys");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(SURVEYS_DIR, { recursive: true });

// ---- 内存会话：token -> { openid, name } ----
const sessions = new Map();

// ---- JSON 文件存储（原子写入，防并发损坏） ----
function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(name, data) {
  const file = path.join(DATA_DIR, name + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- 问卷存储（每个活动一个文件） ----
function readSurveys(activityId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SURVEYS_DIR, activityId + ".json"), "utf8"));
  } catch {
    return [];
  }
}

function appendSurvey(activityId, record) {
  const list = readSurveys(activityId);
  list.push({ ...record, submittedAt: new Date().toISOString() });
  const file = path.join(SURVEYS_DIR, activityId + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
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

// 上传的图片静态服务
app.use("/uploads", express.static(UPLOADS_DIR));

// ---- 鉴权中间件 ----
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.openid = session.openid;
  req.userName = session.name;
  next();
}

function requireAdmin(req, res, next) {
  if (req.openid === ADMIN_OPENID) return next();
  const users = readJSON("users", {});
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
app.get("/api/auth/session", auth, (req, res) => {
  const openid = req.openid;

  if (!ADMIN_OPENID) {
    return res.json({ needConfig: true, myOpenid: openid });
  }

  const users = readJSON("users", {});

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
      writeJSON("users", users);
    }
    users[openid].lastActiveAt = now;
    writeJSON("users", users);
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
    writeJSON("users", users);
    return res.json({ session: { openid, name: users[openid].name, role: "operator", status: "pending", lastActiveAt: now } });
  }

  // 刷新活跃时间
  users[openid].lastActiveAt = now;
  writeJSON("users", users);

  const u = users[openid];
  res.json({ session: { openid, name: u.name, role: u.role, status: u.status, lastActiveAt: u.lastActiveAt || null } });
});

// ---- 用户列表（管理员） ----
app.get("/api/auth/users", auth, requireAdmin, (req, res) => {
  const users = readJSON("users", {});
  const list = Object.entries(users).map(([openid, u]) => ({
    openid, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastActiveAt: u.lastActiveAt || null,
  }));
  res.json({ users: list });
});

// ---- 心跳：记录当前用户活跃时间 ----
app.post("/api/auth/heartbeat", auth, (req, res) => {
  const openid = req.openid;
  const users = readJSON("users", {});
  if (users[openid]) {
    users[openid].lastActiveAt = new Date().toISOString();
    writeJSON("users", users);
  }
  res.json({ ok: true });
});

// ---- 修改用户（管理员） ----
app.patch("/api/auth/users/:openid", auth, requireAdmin, (req, res) => {
  const { openid } = req.params;
  const { name, role, status } = req.body;
  const users = readJSON("users", {});
  if (!users[openid]) return res.status(404).json({ error: "user not found" });

  if (name !== undefined) users[openid].name = name;
  if (role !== undefined) users[openid].role = role;
  if (status !== undefined) users[openid].status = status;
  users[openid].updatedAt = new Date().toISOString();
  writeJSON("users", users);
  res.json({ ok: true });
});

// ---- 移除成员（管理员） ----
app.delete("/api/auth/users/:openid", auth, requireAdmin, (req, res) => {
  const { openid } = req.params;
  if (openid === ADMIN_OPENID) return res.status(400).json({ error: "cannot remove admin" });
  const users = readJSON("users", {});
  delete users[openid];
  writeJSON("users", users);
  res.json({ ok: true });
});

// ---- 活动数据 ----
app.get("/api/activities", auth, (req, res) => {
  res.json(readJSON("activities", []));
});

app.post("/api/activities", auth, (req, res) => {
  writeJSON("activities", req.body.list || []);
  res.json({ ok: true });
});

// ---- 店铺/问卷配置 ----
app.get("/api/store", auth, (req, res) => {
  res.json(readJSON("stores", {}));
});

app.post("/api/store", auth, (req, res) => {
  writeJSON("stores", req.body.map || {});
  res.json({ ok: true });
});

// ---- 活动上传数据 ----
app.get("/api/uploads/:activityId", auth, (req, res) => {
  const uploads = readJSON("uploads", {});
  res.json(uploads[req.params.activityId] || null);
});

app.post("/api/uploads/:activityId", auth, (req, res) => {
  const uploads = readJSON("uploads", {});
  uploads[req.params.activityId] = req.body.uploads;
  writeJSON("uploads", uploads);
  res.json({ ok: true });
});

// ---- 图片上传（base64 → 文件） ----
app.post("/api/upload", auth, async (req, res) => {
  const { base64, name, activityId, kind } = req.body;
  if (!base64) return res.status(400).json({ error: "missing base64" });

  const ext = ((name || "x.jpg").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const filename = `${activityId || "misc"}/${kind || "img"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const data = base64.replace(/^data:[^;]+;base64,/, "");
  fs.writeFileSync(filepath, Buffer.from(data, "base64"));

  res.json({ url: "/uploads/" + filename, fileID: "" });
});

// ---- 问卷公开接口（无需登录） ----
app.get("/api/survey/:activityId", (req, res) => {
  const activities = readJSON("activities", []);
  const stores = readJSON("stores", {});
  const activity = activities.find((a) => a.id === req.params.activityId) || null;
  const survey = (activity && stores[activity.id] && stores[activity.id].survey) || [];
  res.json({ activity, survey });
});

app.post("/api/survey/:activityId", (req, res) => {
  appendSurvey(req.params.activityId, req.body.record || req.body);
  res.json({ ok: true });
});

// ---- 问卷列表（管理员） ----
app.get("/api/surveys/:activityId", auth, (req, res) => {
  res.json(readSurveys(req.params.activityId));
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
  if (!APPID || !APPSECRET) console.warn("  ⚠️  未配置 APPID/APPSECRET，微信登录不可用");
  if (!ADMIN_OPENID) console.warn("  ⚠️  未配置 ADMIN_OPENID，首次打开显示「系统未初始化」页面\n");
  else console.log("");
});
