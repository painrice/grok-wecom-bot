const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

// Load .env (PM2 / bare node may not inject WECOM_* vars)
// GROK_MODEL / GROK_BIN 强制以 .env 为准（PM2 daemon 旧 env 常年不刷新）
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
    if (!(key in process.env) || process.env[key] === "" || key === "GROK_MODEL" || key === "GROK_BIN") process.env[key] = val;
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

// Circuit breaker —— 模块级单例：熔断状态必须跨调用持续累积才有效
// （旧版在 grokPrompt 内每次 new，failures 永远从 0 起，熔断形同虚设）
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
const grokBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 30000 });

// Metrics (Prometheus)
const client = require("prom-client");
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const msgLatency = new client.Histogram({ name: "wecom_msg_latency_seconds", help: "Message processing latency", labelNames: ["agent"], registers: [register] });
const grokErrors = new client.Counter({ name: "grok_errors_total", help: "Grok call errors", labelNames: ["type"], registers: [register] });
const streamFallbacks = new client.Counter({ name: "stream_fallbacks_total", help: "Stream fallback count", registers: [register] });

// 错误归类：label 用固定类型，禁止用 err.message（基数爆炸 + 泄漏用户内容进指标）
function classifyError(err) {
  if (err && err.code === "CB_OPEN") return "circuit_open";
  const m = String((err && err.message) || err || "");
  if (/超过|timeout|timed out/i.test(m)) return "timeout";
  if (/exited|spawn|ENOENT|EACCES/i.test(m)) return "process";
  return "other";
}

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
const CTX_TURNS = Number(process.env.CTX_TURNS) || 10;
const CTX_PER_MSG = Number(process.env.CTX_PER_MSG) || 500;
const CTX_AGENT = "grok-wecom";
// 流生命周期 10 分钟（846608 过期）；进度流死后降级 sendMessage 低频汇报
const DEAD_NOTIFY_EVERY_MS = 3 * 60 * 1000;
// 流累计 / 单条 sendMessage 分块上限（40058 保护，与 pi-wecom 实测值对齐）
const STREAM_CHUNK = 18000;

// ── 会话隔离：私聊 user:<userid>，群聊 group:<chatid> ──
// 历史上下文、缓存、串行队列、grok 工作目录全部以 chatkey 为准，
// 避免同一个人「群聊里聊的内容串进私聊上下文」（旧版只按 userid）
function sessionKeyOf(chatType, userid, chatid) {
  const isGroup = chatType === "group" || chatType === "groupchat";
  return isGroup ? ("group:" + (chatid || userid)) : ("user:" + userid);
}
function safeKeyOf(key) { return String(key).replace(/[^A-Za-z0-9_-]/g, "_"); }

// Strip ANSI
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b[()][AB012]/g, "").replace(/\0/g, "");

// Strip agent/tool-call scaffolding leaked into final answer, so users see clean prose
// 先保护 markdown 代码围栏：脚手架清理不得触碰代码内容（写 HTML/XML 时代码块会被误删）
function cleanModelOutput(str) {
  if (!str) return str;
  const fences = [];
  let s = String(str).replace(/```[\s\S]*?```/g, (m) => { fences.push(m); return "\u0000F" + (fences.length - 1) + "\u0000"; });
  // 1) Remove full scaffold blocks (function_calls / invoke / parameter / antml wrappers)
  s = s.replace(/\s*<(?:function_calls|invoke|parameter|antml:[a-z_]+)\b[\s\S]*?<\/(?:function_calls|invoke|parameter|antml:[a-z_]+)>\s*/gi, " ");
  // 2) Remove any tool-invocation tag with attrs: <tag ...> ... </tag>  (non-common-HTML whitelist)
  s = s.replace(/<([a-z][a-z0-9_]*(?:=[^\s>]+)?)[^>]*>[\s\S]*?<\/\1>\s*/gi, (m, tag) =>
    /^(df|p|br|hr|img|input|meta|link)$/i.test(tag.split("=")[0]) ? m : " ");
  // 3) From the first remaining scaffold opener, drop the rest (covers truncated output)
  const firstTool = s.search(/<(?:function_calls|invoke|parameter|function=|antml:[a-z_]+|run_terminal_command\b)/i);
  if (firstTool > -1) s = s.slice(0, firstTool);
  // 4) Collapse whitespace
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // 5) Restore fenced code blocks
  if (fences.length) s = s.replace(/\u0000F(\d+)\u0000/g, (m, i) => (fences[Number(i)] != null ? fences[Number(i)] : ""));
  return s;
}

// Helpers
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout " + ms + "ms")), ms))]);

// Build prompt with context（chatkey 已含私聊/群聊隔离）
function buildPrompt(chatkey, currentMsg) {
  const history = sharedMem.formatContextForPrompt(chatkey, CTX_TURNS, CTX_AGENT, CTX_PER_MSG);
  if (!history) return currentMsg;
  return "你是 Grok，正在通过企业微信与用户对话。以下【历史对话】是你们之前的交流，请结合上下文给出连贯、相关的回答；若用户的问题依赖前文，请参考历史。\n\n" + history + "\n\n—— 历史结束 ——\n当前用户消息：\n" + currentMsg;
}

// Input validation（只拦截明确恶意模式，避免误伤编程提问等正常内容）
function validateMessage(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length > 10000) return false;
  if (/<script[\s>]|javascript:/i.test(text)) return false;
  return true;
}

// Grok call with module-level circuit breaker + timeout
async function grokPrompt(chatkey, prompt) {
  return grokBreaker.exec(async () => {
    const userDir = path.join(os.tmpdir(), "grok-wecom-sessions", safeKeyOf(chatkey));
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

// fallback 发送：notifyId 单聊=userid、群聊=群 ID，保证群里的问题答案回群里。
// 超长分块（40058 保护），非末块加「（未完）」尾标
async function sendLong(cid, text) {
  try {
    if (!text) return;
    if (text.length <= STREAM_CHUNK) {
      await withTimeout(ws.sendMessage(cid, { msgtype: "markdown", markdown: { content: text } }), SEND_TIMEOUT_MS);
      return;
    }
    for (let i = 0; i < text.length; i += STREAM_CHUNK) {
      const tail = (i + STREAM_CHUNK < text.length) ? "（未完）" : "";
      await withTimeout(ws.sendMessage(cid, { msgtype: "markdown", markdown: { content: text.slice(i, i + STREAM_CHUNK) + tail } }), SEND_TIMEOUT_MS);
    }
  } catch (e) { logger.error("sendLong failed", { err: e.message }); }
}

// ── 用户命令（不走模型、不入历史）──
const COMMANDS = ["/new", "/status", "/help"];

function countHistory(chatkey) {
  try { return sharedMem.countConversation(chatkey, CTX_AGENT); } catch (e) { return 0; }
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return (h > 0 ? h + " 小时 " : "") + m + " 分钟";
}

async function handleCommand(chatkey, cmd, notifyId) {
  if (cmd === "/help") {
    await sendLong(notifyId, "📖 可用命令：\n**/new** — 清空当前会话上下文，开始新对话\n**/status** — 查看当前会话状态\n**/help** — 显示本帮助\n\n直接发消息即可与 Grok 对话。私聊与群聊上下文相互隔离；超过 10 分钟的长任务自动转入后台，每 3 分钟汇报一次进度，完成后自动通知。");
  } else if (cmd === "/new") {
    const rounds = countHistory(chatkey);
    sharedMem.clearConversation(chatkey, CTX_AGENT);
    logger.info("cmd /new", { key: chatkey, cleared: rounds });
    await sendLong(notifyId, "✅ 已清空当前会话上下文（清除 " + rounds + " 条记录），开始新对话。");
  } else if (cmd === "/status") {
    await sendLong(notifyId, "🤖 Grok 会话状态\n模型：" + GROK_MODEL + "\n上下文：保留最近 " + CTX_TURNS + " 轮，当前累计 " + countHistory(chatkey) + " 条\n单次任务超时：" + Math.round(GROK_TIMEOUT_MS / 60000) + " 分钟\n进程已运行：" + formatUptime(process.uptime()));
  }
}

// Handle message（qwenpaw/hermes 式：进度走流、最终结果 100% 走 sendMessage 独立送达）
async function handleMessage(fr, chatkey, text, notifyId) {
  const start = Date.now();
  const streamId = generateReqId("s");
  const streamState = { dead: false };
  const markStreamDead = (reason) => {
    if (!streamState.dead) { streamState.dead = true; logger.warn("stream dead", { reason }); }
  };

  // 进度推送：'skipped'（上帧未 ack 主动跳过）属正常；其余任何 errcode 都视为流不可用。
  // 旧版只认 846608 且把 'skipped' 误判为成功，是长任务结果丢失/失联的根因
  async function pushProgress(content, fin) {
    if (streamState.dead) return false;
    const fn = streamReplyFn();
    if (typeof fn !== "function") { markStreamDead("no stream method"); return false; }
    let r;
    try { r = await withTimeout(fn.call(ws, fr, streamId, content, fin !== false), SEND_TIMEOUT_MS); }
    catch (e) { markStreamDead("ws error: " + e.message); return false; }
    if (r && r !== "skipped" && r.errcode) { markStreamDead("errcode " + r.errcode); return false; }
    return true;
  }

  // 缓存 key 含会话：防跨用户/跨群串答案（旧版只 hash 文本）
  const cacheKey = "grok:" + chatkey + ":" + crypto.createHash("md5").update(text).digest("hex");
  const cached = await sharedMem.cache.get(cacheKey);
  if (cached) {
    await sendLong(notifyId, cached);
    msgLatency.observe({ agent: CTX_AGENT }, (Date.now() - start) / 1000);
    return;
  }

  const prompt = buildPrompt(chatkey, text);
  await pushProgress("🤔 正在思考…", false);

  let elapsed = 0, deadAnnounced = false, lastDeadNotify = 0;
  const keep = setInterval(async () => {
    elapsed += KEEPALIVE_MS / 1000;
    if (streamState.dead) {
      // 流已过期：降级为 sendMessage 低频进度汇报（不推已作废的流）
      const now = Date.now();
      if (!deadAnnounced) {
        deadAnnounced = true; lastDeadNotify = now;
        sendLong(notifyId, "⏳ 仍在处理（已 " + Math.round(elapsed) + "s），进度流已达 10 分钟上限，任务转入后台执行，每 3 分钟汇报一次进度，完成后自动通知你");
      } else if (now - lastDeadNotify >= DEAD_NOTIFY_EVERY_MS) {
        lastDeadNotify = now;
        sendLong(notifyId, "⏳ 仍在处理…（已 " + Math.round(elapsed) + "s）");
      }
      return;
    }
    await pushProgress("⏳ 仍在处理中…（已 " + Math.round(elapsed) + "s）", false);
  }, KEEPALIVE_MS);

  let replySent = false;
  // 最终结果投递：不依赖流状态判断（旧版「流推送成功与否」无法可靠判定，
  // 'skipped'/20480 累计超限等静默失败会丢结果）；进度流只负责收口，失败无所谓
  async function finish(text) {
    if (replySent) return;
    replySent = true;
    clearInterval(keep);
    if (!streamState.dead) await pushProgress("", true).catch(() => {});
    await sendLong(notifyId, text || "（模型未返回内容，请稍后再试）");
    streamFallbacks.inc();  // 结果走 sendMessage 通道，统一计数便于观测
  }

  try {
    const result = await grokPrompt(chatkey, prompt);
    const final = cleanModelOutput(result) || "（空回复）";
    // 成功才落历史（失败时用户消息不残留，避免下轮带上「问过但没回答」的记录）
    sharedMem.appendConversation(CTX_AGENT, chatkey, "user", text);
    sharedMem.appendConversation(CTX_AGENT, chatkey, "assistant", final);
    sharedMem.cache.set(cacheKey, final, 600); // Cache 10 min
    await finish(final);
    msgLatency.observe({ agent: CTX_AGENT }, (Date.now() - start) / 1000);
  } catch (err) {
    grokErrors.inc({ type: classifyError(err) });
    logger.error("grok error", { err: err.message });
    await finish("❌ " + err.message);
  }
}

// 会话级串行队列（chatkey 粒度：私聊/群聊互不阻塞；空闲后清理 Map 防泄漏）
const userLocks = new Map();
async function runForUser(chatkey, task) {
  const prev = userLocks.get(chatkey) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  userLocks.set(chatkey, next);
  await prev.catch(() => {});
  try { return await task(); }
  finally {
    release();
    // 仅当没有后来者覆盖锁时才删除（有排队者时 get !== 自身 next）
    if (userLocks.get(chatkey) === next) userLocks.delete(chatkey);
  }
}

// WebSocket
let ws = null;
function connectWS() {
  ws = new AiBot.WSClient({ botId, secret, maxReconnectAttempts: -1, heartbeatInterval: 30000, requestTimeout: 60000 });
  ws.on("authenticated", () => logger.info("Auth OK"));
  ws.on("disconnected", (r) => logger.warn("Disc", { reason: r }));
  ws.on("reconnecting", (a, d) => logger.info("Reconn", { attempt: a, delay: d }));
  ws.on("message.text", (fr) => {
    const c = fr.body?.text?.content, u = fr.body?.from?.userid;
    const ct = fr.body?.chattype || fr.body?.chatType;
    if (!c || !u) return;
    const isGroup = ct === "group" || ct === "groupchat";
    let m = c; if (isGroup) m = c.replace(/^@\S+\s*/, "").trim();
    if (!m) return;
    const notifyId = String(isGroup ? (fr.body.chatid || u) : u);  // 群聊回群、单聊回私聊
    const chatkey = sessionKeyOf(ct, u, fr.body.chatid);
    logger.info("msg", { key: chatkey, text: m.substring(0, 80) });
    if (COMMANDS.includes(m)) {
      handleCommand(chatkey, m, notifyId).catch(e => logger.error("cmd failed", { err: e.message }));
      return;
    }
    if (!validateMessage(m)) { sendLong(notifyId, "❌ 输入包含不允许的内容"); return; }
    runForUser(chatkey, () => handleMessage(fr, chatkey, m, notifyId)).catch(e => logger.error("handle failed", { err: e.message }));
  });
  ws.on("message.image", (fr) => {
    const u = fr.body?.from?.userid;
    const ct = fr.body?.chattype || fr.body?.chatType;
    const notifyId = String((ct === "group" || ct === "groupchat") ? (fr.body.chatid || u) : u);
    sendLong(notifyId, "[暂不支持图片]");
  });
  ws.on("event.enter_chat", (fr) => { ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! Grok here" } }).catch(e => logger.warn("welcome fail", { err: e.message })); });
  ws.connect();
}

async function main() {
  console.log("===================");
  console.log(" Grok-WeCom Bridge (v3: session-isolated)");
  console.log(" BotID: " + botId.substring(0, 10) + "...");
  console.log(" Agent: grok -> " + GROK_MODEL);
  console.log(" GROK_TIMEOUT_MS=" + GROK_TIMEOUT_MS + " KEEPALIVE_MS=" + KEEPALIVE_MS);
  console.log(" CTX_TURNS=" + CTX_TURNS + " CTX_PER_MSG=" + CTX_PER_MSG + " (user:/group: isolated)");
  console.log(" Dead-notify every " + (DEAD_NOTIFY_EVERY_MS / 1000) + "s; sendLong chunk=" + STREAM_CHUNK);
  console.log("===================");
  logger.info("bridge.start", { model: GROK_MODEL, timeout: GROK_TIMEOUT_MS, chunk: STREAM_CHUNK });
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
