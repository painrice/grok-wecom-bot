const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || (function() {
  return "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
});

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) {
  console.error("[FATAL] Missing WECOM_BOT_ID / WECOM_BOT_SECRET");
  process.exit(1);
}

// ── Grok Build CLI ──
const { spawn } = require("node:child_process");
const path = require("node:path");

const GROK_BIN = process.env.GROK_BIN || path.join(
  process.env.HOME || "/root",
  ".local/bin/grok"
);
const GROK_MODEL = process.env.GROK_MODEL || "longcat";

// Strip ANSI escape codes from grok output
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][AB012]/g, '').replace(/\0/g, '');
}

function grokPrompt(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "-m", GROK_MODEL,
      "--no-alt-screen",
      "--always-approve",
    ];
    const proc = spawn(GROK_BIN, args, {
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
        reject(new Error("grok exited " + code + ": " + stderr.trim()));
      } else {
        resolve(stripAnsi(stdout.trim()));
      }
    });
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
  ws.on("disconnected", function(r) {
    console.warn("[Bridge] Disc: " + r);
    // Auto-reconnect after 2s
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(function() { reconnecting = false; connectWS(); }, 2000);
    }
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

    // 生成固定的 streamId，确保 thinking 和最终回复使用同一个 stream
    const streamId = generateReqId("s");

    // Send "thinking" indicator immediately (fin=false, will be overwritten by final reply)
    ws.replyStreamNonBlocking(fr, streamId, "🤔 正在思考…", false).catch(function() {});

    let replySent = false;
    try {
      const result = await grokPrompt(m);
      if (replySent) return;  // 防重复
      replySent = true;
      const text = result || "（空回复）";
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
    ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! 小虎哥 here 🐯" } }).catch(function() {});
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
