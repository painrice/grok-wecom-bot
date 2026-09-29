// grok-wecom-bot — 改进版 index.cjs
// 修复：
//   A. 长任务收不到回复（企微 5/6 分钟流式超时 → 降级主动推送 sendMessage）
//   B. 多轮上下文缺失（手动把历史对话注入 prompt，不依赖 grok session 存储）
//
// 变更清单：
//   1. 兼容 replyStream / replyStreamNonBlocking 两种 SDK 方法名
//   2. 收到消息 5 秒内发占位，期间每 KEEPALIVE_MS 发进度续命（仅 846608 判定流式失效）
//   3. grok 进程带防卡死超时（GROK_TIMEOUT_MS），超时杀进程并提示
//   4. 最终回复优先流式收尾；若流式已失效则降级 sendMessage 主动推送（突破 5 分钟限制）
//   5. 发送失败统一带超时 + 日志 + 失败告警，不再静默吞错
//   6. 每用户串行处理，避免长任务时多 grok 进程雪崩
//   7. 多轮上下文：每次调用前把最近 N 轮（仅 grok-wecom agent）注入 prompt；
//      去掉无效的 grok -c 续会话逻辑，改为 stateless + 历史注入，更稳定

const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || (function (p) {
  return (p || "req_") + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
});

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) {
  console.error("[FATAL] Missing WECOM_BOT_ID / WECOM_BOT_SECRET");
  process.exit(1);
}

const sharedMem = require("./shared-memory.cjs");

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const GROK_BIN = process.env.GROK_BIN || path.join(process.env.HOME || "/root", ".local/bin/grok");
const GROK_MODEL = process.env.GROK_MODEL || "grok";

// ── 超时/保活参数（均可通过环境变量覆盖）──
const ACK_TIMEOUT_MS = 4000;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS) || 25000;
const GROK_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS) || 30 * 60 * 1000;
const SEND_TIMEOUT_MS = 8000;
const STREAM_EXPIRED = 846608;

// ── 多轮上下文参数 ──
const CTX_TURNS = Number(process.env.CTX_TURNS) || 10;      // 注入最近多少条消息
const CTX_PER_MSG = Number(process.env.CTX_PER_MSG) || 500;  // 每条历史消息截断长度
const CTX_AGENT = "grok-wecom";                             // 仅读取本 agent 的历史，避免跨 bot 串味

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b[()][AB012]/g, "").replace(/\0/g, "");
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("send timeout " + ms + "ms")), ms)),
  ]);
}

// ── 构建带历史上下文的 prompt ──
// 注意：必须在 appendConversation(user) 之前调用，否则本轮用户消息会重复出现在历史里
function buildPrompt(userId, currentMsg) {
  const history = sharedMem.formatContextForPrompt(userId, CTX_TURNS, CTX_AGENT, CTX_PER_MSG, "Grok");
  if (!history) return currentMsg;
  return (
    "你是 Grok，正在通过企业微信与用户对话。以下【历史对话】是你们之前的交流，请结合上下文给出连贯、相关的回答；若用户的问题依赖前文，请参考历史。\n\n" +
    history +
    "\n\n—— 历史结束 ——\n当前用户消息：\n" + currentMsg
  );
}

// ── grok 调用（stateless + 超时可中断）──
function grokPrompt(userId, prompt) {
  return new Promise((resolve, reject) => {
    const userDir = path.join(os.tmpdir(), "grok-wecom-sessions", userId);
    fs.mkdirSync(userDir, { recursive: true });
    const args = ["-p", prompt, "-m", GROK_MODEL, "--no-alt-screen", "--always-approve"];
    const proc = spawn(GROK_BIN, args, { cwd: userDir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, GROK_TIMEOUT_MS);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error("grok 执行超过 " + (GROK_TIMEOUT_MS / 60000) + " 分钟，已强制中止（任务过长或被卡住）"));
        return;
      }
      if (code !== 0) {
        reject(new Error("grok exited " + code + ": " + stderr.trim()));
      } else {
        resolve(stripAnsi(stdout.trim()));
      }
    });
  });
}

// ── 企微发送封装 ──
function streamReplyFn() {
  return ws.replyStream || ws.replyStreamNonBlocking;
}

async function safeStreamReply(fr, streamId, content, finish) {
  const fn = streamReplyFn();
  if (typeof fn !== "function") {
    console.error("[Bridge] 当前 SDK 既无 replyStream 也无 replyStreamNonBlocking，请升级 @wecom/aibot-node-sdk");
    return { errcode: -2, errmsg: "no stream method" };
  }
  try {
    const r = await withTimeout(fn.call(ws, fr, streamId, content, finish), SEND_TIMEOUT_MS);
    if (r && r.errcode && r.errcode !== 0) {
      console.warn("[Bridge] stream reply errcode=" + r.errcode + " errmsg=" + (r.errmsg || "") + " finish=" + finish);
    }
    return r || { errcode: 0 };
  } catch (e) {
    console.warn("[Bridge] stream reply failed (finish=" + finish + "): " + e.message);
    return { errcode: -1, errmsg: e.message };
  }
}

async function pushLongMarkdown(chatid, text) {
  const MAX = 20000;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  for (let i = 0; i < chunks.length; i++) {
    const body = { msgtype: "markdown", markdown: { content: chunks[i] } };
    try {
      await withTimeout(ws.sendMessage(chatid, body), SEND_TIMEOUT_MS);
      console.log("[Bridge] 主动推送分片 " + (i + 1) + "/" + chunks.length);
    } catch (e) {
      console.error("[Bridge] 主动推送分片失败: " + e.message);
    }
  }
}

async function deliverFinal(fr, chatid, streamId, text, streamDead) {
  if (!streamDead) {
    const r = await safeStreamReply(fr, streamId, text, true);
    const ok = r && (r.errcode === 0 || r.errcode === undefined);
    if (ok) {
      console.log("[Bridge] 流式收尾成功");
      return;
    }
    if (r && r.errcode === STREAM_EXPIRED) streamDead = true;
  }
  console.warn("[Bridge] 流式收尾失败，降级为主动推送 (streamDead=" + streamDead + ")");
  if (text.length > 20000) {
    await pushLongMarkdown(chatid, text);
  } else {
    const body = { msgtype: "markdown", markdown: { content: text } };
    try {
      await withTimeout(ws.sendMessage(chatid, body), SEND_TIMEOUT_MS);
      console.log("[Bridge] 已通过主动推送送达");
    } catch (e) {
      console.error("[Bridge] 主动推送也失败: " + e.message);
    }
  }
}

// ── 处理单条消息 ──
async function handleMessage(fr, user, text, chatid) {
  const streamId = generateReqId("s");
  let streamDead = false;

  // 0) 先构建上下文（此时历史不含本轮，避免重复），随后再记录本轮用户消息
  const prompt = buildPrompt(user, text);
  sharedMem.appendConversation(CTX_AGENT, user, "user", text);
  sharedMem.updateUserProfile(user, { agent: CTX_AGENT });

  // 1) 5 秒内发占位（满足企微回调超时要求）
  await safeStreamReply(fr, streamId, "🤔 正在思考…", false);

  // 2) 周期发进度，续命流式通道；仅当收到 846608 才判定流式失效
  let elapsed = 0;
  const keep = setInterval(() => {
    (async () => {
      elapsed += KEEPALIVE_MS / 1000;
      const r = await safeStreamReply(fr, streamId, "⏳ 仍在处理中…（已 " + elapsed + "s）", false);
      if (r && r.errcode === STREAM_EXPIRED) {
        clearInterval(keep);
        streamDead = true;
        console.warn("[Bridge] 流式通道已超时(846608)，转为后台主动推送");
      }
    })().catch((e) => console.warn("[Bridge] keepalive err: " + e.message));
  }, KEEPALIVE_MS);

  try {
    const result = await grokPrompt(user, prompt);
    clearInterval(keep);
    const final = result || "（空回复）";
    sharedMem.appendConversation(CTX_AGENT, user, "assistant", final);
    await deliverFinal(fr, chatid, streamId, final, streamDead);
  } catch (err) {
    clearInterval(keep);
    console.error("[Bridge] grok error: " + err.message);
    await deliverFinal(fr, chatid, streamId, "❌ " + err.message, streamDead);
  }
}

// ── 每用户串行，避免长任务时多进程雪崩 ──
const userLocks = new Map();
async function runForUser(userId, task) {
  const prev = userLocks.get(userId) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  userLocks.set(userId, next);
  await prev;
  try {
    return await task();
  } finally {
    release();
  }
}

// ── WebSocket client ──
let ws = null;
function connectWS() {
  ws = new AiBot.WSClient({
    botId, secret,
    maxReconnectAttempts: -1,
    heartbeatInterval: 30000,
    requestTimeout: 60000,
  });

  ws.on("authenticated", () => console.log("[Bridge] Auth OK"));
  ws.on("disconnected", (r) => console.warn("[Bridge] Disc: " + r + " (SDK 将自动重连)"));
  ws.on("reconnecting", (a, d) => console.log("[Bridge] Reconn #" + a + " " + d + "ms"));

  ws.on("message.text", (fr) => {
    const c = fr.body && fr.body.text ? fr.body.text.content : null;
    const u = fr.body && fr.body.from ? fr.body.from.userid : null;
    const ct = fr.body ? fr.body.chattype || fr.body.chatType : null;
    if (!c || !u) return;
    let m = c;
    if (ct === "group" || ct === "groupchat") m = c.replace(/^@\S+\s*/, "").trim();
    if (!m) return;
    console.log("[Bridge] " + u + ": " + m.substring(0, 80));

    const chatid = ct === "group" || ct === "groupchat" ? (fr.body.chatid || u) : u;
    runForUser(u, () => handleMessage(fr, u, m, chatid)).catch((e) => console.error("[Bridge] UH: " + e));
  });

  ws.on("message.image", (fr) => {
    const u2 = fr.body && fr.body.from ? fr.body.from.userid : null;
    if (!u2) return;
    safeStreamReply(fr, generateReqId("i"), "[暂不支持图片]", true);
  });

  ws.on("event.enter_chat", (fr) => {
    ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! Grok here" } }).catch((e) => console.warn("[Bridge] welcome fail: " + e));
  });

  ws.connect();
}

async function main() {
  console.log("[Bridge] Grok Build CLI ready");
  connectWS();

  const sd = (s) => {
    console.log("[" + s + "] exit");
    if (ws) ws.disconnect();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => sd("SIGINT"));
  process.on("SIGTERM", () => sd("SIGTERM"));
  process.on("unhandledRejection", (r) => console.error("[Bridge] UH: " + r));

  console.log("===================");
  console.log(" Grok-WeCom Bridge (improved)");
  console.log(" BotID: " + botId.substring(0, 10) + "...");
  console.log(" Agent: grok -> " + GROK_MODEL);
  console.log(" GROK_TIMEOUT_MS=" + GROK_TIMEOUT_MS + " KEEPALIVE_MS=" + KEEPALIVE_MS);
  console.log(" CTX_TURNS=" + CTX_TURNS + " CTX_PER_MSG=" + CTX_PER_MSG);
  console.log("===================");
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
