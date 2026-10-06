const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SHARED_DIR = process.env.SHARED_AGENT_DIR || path.join(
  process.env.HOME || '/root', '.qwenpaw/workspaces/default/memory/shared'
);
const DB_PATH = process.env.CONVERSATION_DB || path.join(SHARED_DIR, 'conversations.db');

// SQLite backend for concurrent-safe storage
class SQLiteStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(dbPath);
      this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT,
        userId TEXT,
        role TEXT,
        message TEXT,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      ); CREATE INDEX IF NOT EXISTS idx_agent_user ON conversations (agent, userId);`);
    } catch (e) {
      console.warn('[DB] SQLite unavailable:', e.message);
      this.db = null;
    }
  }
  append(agent, userId, role, msg) {
    if (!this.db) return;
    this.db.prepare('INSERT INTO conversations (agent, userId, role, message) VALUES (?, ?, ?, ?)').run(agent, userId, role, msg.substring(0, 2000));
  }
  query(userId, maxTurns = 10, agentFilter = null) {
    if (!this.db) return [];
    // 用自增 id 排序：ts 只有秒级精度，同秒内 user/assistant 顺序会颠倒
    const stmt = agentFilter
      ? this.db.prepare('SELECT * FROM conversations WHERE userId = ? AND agent = ? ORDER BY id DESC LIMIT ?')
      : this.db.prepare('SELECT * FROM conversations WHERE userId = ? ORDER BY id DESC LIMIT ?');
    return (agentFilter ? stmt.all(userId, agentFilter, maxTurns) : stmt.all(userId, maxTurns)).reverse();
  }
  count(userId, agent) {
    if (!this.db) return 0;
    return this.db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE userId = ? AND agent = ?').get(userId, agent).c;
  }
  clear(userId, agent) {
    if (!this.db) return;
    this.db.prepare('DELETE FROM conversations WHERE userId = ? AND agent = ?').run(userId, agent);
  }
}

// Redis cache layer (optional; only when REDIS_URL is set)
class RedisCache {
  constructor() {
    this.enabled = false;
    this.client = null;
    if (!process.env.REDIS_URL) return;
    try {
      const redis = require('redis');
      this.client = redis.createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false },
      });
      this.client.on('error', () => { this.enabled = false; });
      this.client.connect()
        .then(() => { this.enabled = true; })
        .catch(() => { this.enabled = false; this.client = null; });
    } catch (e) {
      this.enabled = false;
      this.client = null;
    }
  }
  async get(key) {
    if (!this.enabled || !this.client) return null;
    try { return await this.client.get(key); } catch { return null; }
  }
  async set(key, val, ttl = 300) {
    if (!this.enabled || !this.client) return;
    try { await this.client.set(key, val, { EX: ttl }); } catch {}
  }
}

// Plugin framework
const plugins = new Map();
function registerPlugin(name, hooks) {
  plugins.set(name, hooks);
  console.log(`[Plugin] Registered: ${name}`);
}

function trigger(event, data) {
  for (const [name, hooks] of plugins) {
    if (hooks[event]) hooks[event](data);
  }
}

const store = new SQLiteStore(DB_PATH);
const cache = new RedisCache();

module.exports = {
  appendConversation: (agent, userId, role, msg) => { store.append(agent, userId, role, msg); },
  getRecentContext: (userId, maxTurns = 10, agent = null) => store.query(userId, maxTurns, agent),
  countConversation: (userId, agent) => store.count(userId, agent),
  clearConversation: (userId, agent) => { store.clear(userId, agent); },
  formatContextForPrompt: (userId, maxTurns = 6, agent = null, perMsg = 300) => {
    const entries = store.query(userId, maxTurns, agent);
    if (entries.length === 0) return '';
    let ctx = '【历史对话】\n';
    for (const e of entries) {
      const who = e.role === 'user' ? '用户' : '助手';
      const time = (e.ts || '').slice(11, 16);
      ctx += `[${time}] ${who}: ${(e.message || '').substring(0, perMsg)}\n`;
    }
    return ctx;
  },
  registerPlugin,
  trigger,
  SHARED_DIR,
  DB_PATH,
  store,
  cache
};
