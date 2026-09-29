const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

// Load .env (PM2 / bare node may not inject WECOM_* vars)
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env) || process.env[key] === "") process.env[key] = val;
  }
})();

const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || ((p) => (p || "req_") + Date.now() + "_" + Math.random().toString(36).slice(2, 10));
const sharedMem = require("./shared-memory.cjs");

// Structured logger
class Logger {
  constructor(source) { this.source = source; }
  log(level, msg, meta = {}) {
    const entry = { ts: new Date().toISOString(), src: this.source, level, msg, ...meta };
    console.log(JSON.stringify(entry));
  }
  info(msg, m) { this.log("INFO", msg, m); }
  warn(msg, m) { this.log("WARN", msg, m); }
  error(msg, m) { this.log("ERROR", msg, m); }
}
const logger = new Logger("bridge");

// Circuit breaker
class CircuitBreaker {
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold || 5;
    this.resetTimeout = opts.resetTimeout || 60000;
    this.failures = 0;
    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = 0;
    this.lastErr = null;
  }
  async exec(task) {
    if (this.state === "OPEN") {
      if (Date.now() > this.nextAttempt) { this.state = "HALF_OPEN"; }
      else throw Object.assign(new Error("Circuit breaker OPEN"), { code: "CB_OPEN", cause: this.lastErr });
    }
    try {
      const result = await task();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure(e);
      throw e;
    }
  }
  onSuccess() { this.failures = 0; this.state = "CLOSED"; }
  onFailure(e) {
    this.failures++;
    this.lastErr = e;
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
      this.nextAttempt = Date.now() + this.resetTimeout;
      logger.warn("Circuit breaker OPEN", { failures: this.failures, resetIn: this.resetTimeout });
    }
  }
}

// Metrics (Prometheus)
const client = require("prom-client");
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const msgLatency = new client.Histogram({ name: "wecom_msg_latency_seconds", help: "Message processing latency", labelNames: ["agent"], registers: [register] });
const grokErrors = new client.Counter({ name: "grok_errors_total", help: "Grok call errors", labelNames: ["type"], registers: [register] });
const streamFallbacks = new client.Counter({ name: "stream_fallbacks_total", help: "Stream fallback count", registers: [register] });

// Config
const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) { console.error("[FATAL] Missing WECOM_BOT_ID / WECOM_BOT_SECRET"); process.exit(1); }

const GROK_BIN = process.env.GROK_BIN || path.join(process.env.HOME || "/root", ".local/bin/grok");
const GROK_MODEL = process.env.GROK_MODEL || "grok";
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS) || 4000;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 25000;
const GROK_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS) || 30 * 60 * 1000;
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS) || 8000;
const STREAM_EXPIRED = 846608;
const CTX_TURNS = Number(process.env.CTX_TURNS) || 10;
const CTX_PER_MSG = Number(process.env.CTX_PER_MSG) || 500;
const CTX_AGENT = "grok-wecom";

// Strip ANSI
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b[()][AB012]/g, "").replace(/\0/g, "");

// Helpers
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout " + ms + "ms")), ms))]);

// Build prompt with context
function buildPrompt(userId, currentMsg) {
  const history = sharedMem.formatContextForPrompt(userId, CTX_TURNS, CTX_AGENT, CTX_PER_MSG, "Grok");
  if (!history) return currentMsg;
  return "你是 Grok，正在通过企业微信与用户对话。以下【历史对话】是你们之前的交流，请结合上下文给出连贯、相关的回答；若用户的问题依赖前文，请参考历史。\n\n" + history + "\n\n—— 历史结束 ——\n当前用户消息：\n" + currentMsg;
}

// Input validation
function validateMessage(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length > 10000) return false;
  // Block obvious injection patterns
  if (/<script|javascript:|eval\(|exec\s*\(|\bddos\b/i.test(text)) return false;
  return true;
}

// Process pool
class ProcessPool {
  constructor(maxSize = 3) { this.maxSize = maxSize; this.idle = []; this.busy = 0; }
  async acquire() {
    if (this.idle.length > 0) return this.idle.pop();
    if (this.busy < this.maxSize) { this.busy++; return this.create(); }
    return null; // Pool exhausted
  }
  release(proc) { this.idle.push(proc); this.busy = Math.max(0, this.busy - 1); }
  create() { return { used: 0 }; }
}
const pool = new ProcessPool(Number(process.env.POOL_SIZE) || 3);

// Grok call with circuit breaker + timeout
async function grokPrompt(userId, prompt) {
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 30000 });
  return breaker.exec(async () => {
    const userDir = path.join(os.tmpdir(), "grok-wecom-sessions", userId);
    fs.mkdirSync(userDir, { recursive: true });
    const args = ["-p", prompt, "-m", GROK_MODEL, "--no-alt-screen", "--always-approve"];
    const proc = spawn(GROK_BIN, args, { cwd: userDir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill("SIGKILL"); } catch (_) {} }, GROK_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      proc.stdout.on("data", d => stdout += d);
      proc.on("error", err => { clearTimeout(timer); reject(err); });
      proc.on("close", code => {
        clearTimeout(timer);
        if (killed) reject(new Error("grok 执行超过 " + (GROK_TIMEOUT_MS / 60000) + " 分钟，已强制中止"));
        else if (code !== 0) reject(new Error("grok exited " + code + ": " + stderr.trim()));
        else resolve(stripAnsi(stdout.trim()));
      });
    });
  });
}

// Stream helper
function streamReplyFn() { return ws.replyStream || ws.replyStreamNonBlocking; }
async function safeStreamReply(fr, sid, content, finish) {
  const fn = streamReplyFn();
  if (typeof fn !== "function") return { errcode: -2, errmsg: "no stream method" };
  try {
    const r = await withTimeout(fn.call(ws, fr, sid, content, finish), SEND_TIMEOUT_MS);
    if (r && r.errcode && r.errcode !== 0) logger.warn("stream err", { errcode: r.errcode, finish });
    return r || { errcode: 0 };
  } catch (e) {
    logger.warn("stream failed", { finish, err: e.message });
    return { errcode: -1, errmsg: e.message };
  }
}
async function pushLongMarkdown(chatid, text) {
  const MAX = 20000, chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  for (let i = 0; i < chunks.length; i++) {
    try { await withTimeout(ws.sendMessage(chatid, { msgtype: "markdown", markdown: { content: chunks[i] } }), SEND_TIMEOUT_MS); } catch (e) { logger.error("push chunk failed", { i, err: e.message }); }
  }
}
async function deliverFinal(fr, chatid, sid, text, streamDead) {
  if (!streamDead) {
    const r = await safeStreamReply(fr, sid, text, true);
    if (r && (r.errcode === 0 || r.errcode === undefined)) { logger.info("stream finish ok"); return; }
    if (r && r.errcode === STREAM_EXPIRED) streamDead = true;
  }
  logger.warn("stream fallback to sendMessage");
  streamFallbacks.inc();
  if (text.length > 20000) await pushLongMarkdown(chatid, text);
  else {
    try { await withTimeout(ws.sendMessage(chatid, { msgtype: "markdown", markdown: { content: text } }), SEND_TIMEOUT_MS); } catch (e) { logger.error("sendMessage failed", { err: e.message }); }
  }
}

// Handle message
async function handleMessage(fr, user, text, chatid) {
  const streamId = generateReqId("s"), start = Date.now();
  let streamDead = false;
  if (!validateMessage(text)) { await safeStreamReply(fr, streamId, "❌ 输入包含不允许的内容", true); return; }

  // Cache check
  const cacheKey = "grok:" + require("crypto").createHash("md5").update(text).digest("hex");
  const cached = await sharedMem.cache.get(cacheKey);
  if (cached) { await deliverFinal(fr, chatid, streamId, cached, false); return; }

  const prompt = buildPrompt(user, text);
  sharedMem.appendConversation(CTX_AGENT, user, "user", text);
  await safeStreamReply(fr, streamId, "🤔 正在思考…", false);

  let elapsed = 0;
  const keep = setInterval(async () => {
    elapsed += KEEPALIVE_MS / 1000;
    const r = await safeStreamReply(fr, streamId, "⏳ 仍在处理中…（已 " + elapsed + "s）", false);
    if (r && r.errcode === STREAM_EXPIRED) { clearInterval(keep); streamDead = true; logger.warn("stream expired"); }
  }, KEEPALIVE_MS);

  try {
    const result = await grokPrompt(user, prompt);
    clearInterval(keep);
    const final = result || "（空回复）";
    sharedMem.appendConversation(CTX_AGENT, user, "assistant", final);
    await sharedMem.cache.set(cacheKey, final, 600); // Cache 10 min
    await deliverFinal(fr, chatid, streamId, final, streamDead);
    msgLatency.observe({ agent: CTX_AGENT }, (Date.now() - start) / 1000);
  } catch (err) {
    clearInterval(keep);
    grokErrors.inc({ type: err.message });
    logger.error("grok error", { err: err.message });
    await deliverFinal(fr, chatid, streamId, "❌ " + err.message, streamDead);
  }
}

// User serial queue
const userLocks = new Map();
async function runForUser(userId, task) {
  const prev = userLocks.get(userId) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  userLocks.set(userId, next);
  await prev;
  try { return await task(); } finally { release(); }
}

// WebSocket
let ws = null;
function connectWS() {
  ws = new AiBot.WSClient({ botId, secret, maxReconnectAttempts: -1, heartbeatInterval: 30000, requestTimeout: 60000 });
  ws.on("authenticated", () => logger.info("Auth OK"));
  ws.on("disconnected", (r) => logger.warn("Disc", { reason: r }));
  ws.on("reconnecting", (a, d) => logger.info("Reconn", { attempt: a, delay: d }));
  ws.on("message.text", (fr) => {
    const c = fr.body?.text?.content, u = fr.body?.from?.userid, ct = fr.body?.chattype || fr.body?.chatType;
    if (!c || !u) return;
    let m = c; if (ct === "group" || ct === "groupchat") m = c.replace(/^@\S+\s*/, "").trim();
    if (!m) return;
    const chatid = ct === "group" || ct === "groupchat" ? (fr.body.chatid || u) : u;
    logger.info("msg", { user: u, text: m.substring(0, 80) });
    runForUser(u, () => handleMessage(fr, u, m, chatid)).catch(e => logger.error("uh", { err: e.message }));
  });
  ws.on("message.image", (fr) => { safeStreamReply(fr, generateReqId("i"), "[暂不支持图片]", true); });
  ws.on("event.enter_chat", (fr) => { ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! Grok here" } }).catch(e => logger.warn("welcome fail", { err: e.message })); });
  ws.connect();
}

async function main() {
  console.log("===================");
  console.log(" Grok-WeCom Bridge (optimized v2)");
  console.log(" BotID: " + botId.substring(0, 10) + "...");
  console.log(" Agent: grok -> " + GROK_MODEL);
  console.log(" GROK_TIMEOUT_MS=" + GROK_TIMEOUT_MS + " KEEPALIVE_MS=" + KEEPALIVE_MS);
  console.log(" CTX_TURNS=" + CTX_TURNS + " CTX_PER_MSG=" + CTX_PER_MSG);
  console.log(" PoolSize=" + (Number(process.env.POOL_SIZE) || 3));
  console.log("===================");
  logger.info("bridge.start", { model: GROK_MODEL, timeout: GROK_TIMEOUT_MS });
  connectWS();
  // Prometheus metrics endpoint
  const http = require("http");
  const metricsServer = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", register.contentType);
      res.end(await register.metrics());
    } else { res.writeHead(200); res.end("ok"); }
  });
  metricsServer.listen(Number(process.env.METRICS_PORT) || 9090, () => logger.info("metrics on 9090"));

  const sd = (s) => { console.log("[" + s + "] exit"); if (ws) ws.disconnect(); setTimeout(() => process.exit(0), 500); };
  process.on("SIGINT", () => sd("SIGINT"));
  process.on("SIGTERM", () => sd("SIGTERM"));
  process.on("unhandledRejection", (r) => logger.error("UH", { err: r }));
}
main().catch((e) => { logger.error("FATAL", { err: e }); process.exit(1); });
