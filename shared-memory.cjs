// ═══════════════════════════════════════════════════════════════
// Shared Memory Helper for Multi-Agent WeCom Bridges
// ═══════════════════════════════════════════════════════════════
// Usage: require('./shared-memory.cjs') in any bridge project
// 
// Provides:
//   - appendConversation(agent, userId, role, message) — log to shared JSONL
//   - getRecentContext(userId, maxTurns) — get last N turns for context injection
//   - getUserProfile(userId) — get cross-agent user profile
//   - updateUserProfile(userId, data) — update profile
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SHARED_DIR = process.env.SHARED_AGENT_DIR || path.join(
  process.env.HOME || '/root',
  '.qwenpaw/workspaces/default/memory/shared'
);
const CONVERSATION_LOG = path.join(SHARED_DIR, 'conversations.jsonl');
const USER_PROFILES = path.join(SHARED_DIR, 'user-profiles.json');

function ensureDir() {
  if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
  }
}

function readProfiles() {
  ensureDir();
  if (!fs.existsSync(USER_PROFILES)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_PROFILES, 'utf8'));
  } catch {
    return {};
  }
}

function writeProfiles(profiles) {
  ensureDir();
  fs.writeFileSync(USER_PROFILES, JSON.stringify(profiles, null, 2));
}

/**
 * Append a conversation entry to the shared log
 * @param {string} agent - Agent ID: 'qwenpaw' | 'pi-wecom' | 'grok-wecom' | 'hermes'
 * @param {string} userId - WeCom user ID
 * @param {'user'|'assistant'} role - Who sent the message
 * @param {string} message - The message content
 */
function appendConversation(agent, userId, role, message) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    agent: agent,
    userId: userId,
    role: role,
    message: message.substring(0, 2000) // cap at 2000 chars
  };
  fs.appendFileSync(CONVERSATION_LOG, JSON.stringify(entry) + '\n');
}

/**
 * Get recent conversation context for a user across all agents
 * @param {string} userId - WeCom user ID
 * @param {number} maxTurns - Maximum number of turns to return (default 10)
 * @returns {Array} Array of {ts, agent, role, message} objects
 */
function getRecentContext(userId, maxTurns = 10) {
  ensureDir();
  if (!fs.existsSync(CONVERSATION_LOG)) return [];
  
  const lines = fs.readFileSync(CONVERSATION_LOG, 'utf8')
    .split('\n')
    .filter(Boolean);
  
  const userLines = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.userId === userId) {
        userLines.push(entry);
      }
    } catch { /* skip malformed */ }
  }
  
  // Return last N entries
  return userLines.slice(-maxTurns);
}

/**
 * Format recent context for injection into a model prompt
 * @param {string} userId 
 * @param {number} maxTurns 
 * @returns {string} Formatted context string
 */
function formatContextForPrompt(userId, maxTurns = 6) {
  const entries = getRecentContext(userId, maxTurns);
  if (entries.length === 0) return '';
  
  let ctx = '\n\n--- 历史对话上下文（来自所有Agent） ---\n';
  for (const e of entries) {
    const who = e.role === 'user' ? '用户' : e.agent;
    const time = e.ts.slice(11, 16); // HH:MM
    ctx += `[${time}] ${who}: ${e.message.substring(0, 300)}\n`;
  }
  ctx += '--- 历史结束 ---\n';
  return ctx;
}

/**
 * Get cross-agent user profile
 * @param {string} userId 
 * @returns {object} User profile
 */
function getUserProfile(userId) {
  const profiles = readProfiles();
  return profiles[userId] || { userId, firstSeen: new Date().toISOString(), interactions: 0 };
}

/**
 * Update user profile with new information
 * @param {string} userId 
 * @param {object} data - Fields to merge into profile
 */
function updateUserProfile(userId, data) {
  const profiles = readProfiles();
  const existing = profiles[userId] || { 
    userId, 
    firstSeen: new Date().toISOString(),
    interactions: 0,
    agents: {}
  };
  existing.interactions = (existing.interactions || 0) + 1;
  existing.lastSeen = new Date().toISOString();
  existing.agents = existing.agents || {};
  if (data.agent) {
    existing.agents[data.agent] = (existing.agents[data.agent] || 0) + 1;
  }
  // Merge other fields (name, preferences, topics, etc.)
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'agent') existing[k] = v;
  }
  profiles[userId] = existing;
  writeProfiles(profiles);
}

module.exports = {
  appendConversation,
  getRecentContext,
  formatContextForPrompt,
  getUserProfile,
  updateUserProfile,
  SHARED_DIR,
  CONVERSATION_LOG
};
