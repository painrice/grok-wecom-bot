const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || (function() {
  return "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
});

const botId = "aibckhkgWRSDnXYpGoadBV7gnUJUmSNgg0o";
const secret = "zUnKM8B5SQLjLN3C7vvZFFRvu7wZzvNnHawP7GZUSNg";

// ── 共享记忆模块 ──
const sharedMem = require("./shared-memory.cjs");

// ── Grok Build CLI ──
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const GROK_BIN = process.env.GROK_BIN || path.join(
  process.env.HOME || "/root",
  ".local/bin/grok"
);
const GROK_MODEL = process.env.GROK_MODEL || "grok";

// Strip ANSI escape codes from grok output
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][AB012]/g, '').replace(/\0/g, '');
}

function grokPrompt(userId, prompt) {
  return new Promise((resolve, reject) => {
    // Per-user session isolation: each userId gets its own cwd so `grok -c`
    // resumes that user's session instead of the most recent global one.
    const userDir = path.join(os.tmpdir(), "grok-wecom-sessions", userId);
    fs.mkdirSync(userDir, { recursive: true });

    // First try: continue the user's existing session
    runGrok(userId, userDir, true, prompt, resolve, reject, /*isRetry=*/false);
  });
}

function runGrok(userId, userDir, tryContinue, prompt, resolve, reject, isRetry) {
  const args = [];
  if (tryContinue) args.push("-c");
  args.push("-p", prompt, "-m", GROK_MODEL, "--no-alt-screen", "--always-approve");

  const proc = spawn(GROK_BIN, args, {
    cwd: userDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.on("error", (err) => reject(err));
  proc.on("close", (code) => {
    if (code !== 0) {
      // No session found for this user → create one (only retry once)
      if (tryContinue && !isRetry && /No session found/i.test(stderr)) {
        runGrok(userId, userDir, false, prompt, resolve, reject, /*isRetry=*/true);
        return;
      }
      reject(new Error("grok exited " + code + ": " + stderr.trim()));
    } else {
      resolve(stripAnsi(stdout.trim()));
    }
  });
}

// ── WebSocket client wrapper with auto-reconnect ──
let ws = null;
let reconnecting = false;

function connectWS() {
  ws = new AiBot.WSClient({
    botId, secret,
    maxReconnectAttempts: -1,
    heartbeatInterval: 30000,
    requestTimeout: 60000,
  });

  ws.on("authenticated", function() { console.log("[Bridge] Auth OK"); });
  // 注意：不在此处手动重连。SDK 的 maxReconnectAttempts:-1 已自带自动重连，
  // 再叠加一层手写 connectWS 会与 SDK 互相挤占同一 bot 的长连接，
  // 形成 "Auth OK → 被踢 → 重连 → 再被踢" 死循环，消息落在断开间隙就丢失。
  ws.on("disconnected", function(r) {
    console.warn("[Bridge] Disc: " + r + " (SDK 将自动重连)");
  });
  ws.on("reconnecting", function(a, d) { console.log("[Bridge] Reconn #" + a + " " + d + "ms"); });

  ws.on("message.text", async function(fr) {
    const c = fr.body && fr.body.text ? fr.body.text.content : null;
    const u = fr.body && fr.body.from ? fr.body.from.userid : null;
    const ct = fr.body ? (fr.body.chatType || fr.body.chattype) : null;
    if (!c || !u) return;
    let m = c;
    if (ct === "group" || ct === "groupchat") m = c.replace(/^@\S+\s*/, "").trim();
    if (!m) return;
    console.log("[Bridge] " + u + ": " + m.substring(0, 80));

    // 记录用户消息到共享记忆
    sharedMem.appendConversation("grok-wecom", u, "user", m);
    sharedMem.updateUserProfile(u, { agent: "grok-wecom" });

    // 生成固定的 streamId，确保 thinking 和最终回复使用同一个 stream
    const streamId = generateReqId("s");

    // Send "thinking" indicator immediately (fin=false, will be overwritten by final reply)
    ws.replyStreamNonBlocking(fr, streamId, "🤔 正在思考…", false).catch(function() {});

    let replySent = false;
    try {
      // grok -c 自动恢复该用户的会话历史，无需额外注入上下文
      const result = await grokPrompt(u, m);
      if (replySent) return;  // 防重复
      replySent = true;
      const text = result || "（空回复）";
      
      // 记录助手回复到共享记忆
      sharedMem.appendConversation("grok-wecom", u, "assistant", text);
      
      ws.replyStreamNonBlocking(fr, streamId, text, true).catch(function() {});
    } catch (err) {
      console.error("[Bridge] " + err.message);
      if (replySent) return;  // 防重复
      replySent = true;
      ws.replyStreamNonBlocking(fr, streamId, "Error: " + err.message, true).catch(function() {});
    }
  });

  ws.on("message.image", async function(fr) {
    const u2 = fr.body && fr.body.from ? fr.body.from.userid : null;
    if (!u2) return;
    ws.replyStreamNonBlocking(fr, generateReqId("i"), "[暂不支持图片]", true).catch(function() {});
  });

  ws.on("event.enter_chat", function(fr) {
    ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! Grok here" } }).catch(function() {});
  });

  ws.connect();
}

async function main() {
  console.log("[Bridge] Grok Build CLI ready");
  connectWS();

  const sd = function(s) {
    console.log("[" + s + "] exit");
    if (ws) ws.disconnect();
    setTimeout(function() { process.exit(0); }, 500);
  };
  process.on("SIGINT", function() { sd("SIGINT"); });
  process.on("SIGTERM", function() { sd("SIGTERM"); });
  process.on("unhandledRejection", function(r) { console.error("[Bridge] UH: " + r); });

  console.log("===================");
  console.log(" Grok-WeCom Bridge");
  console.log(" BotID: " + botId.substring(0, 10) + "...");
  console.log(" Agent: grok -> " + GROK_MODEL);
  console.log("===================");
}

main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
