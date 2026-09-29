// ═══════════════════════════════════════════════════════════════
// Shared Memory Helper for Multi-Agent WeCom Bridges
// ═══════════════════════════════════════════════════════════════
// Usage: require('./shared-memory.cjs') in any bridge project
// 
// Provides:
//   - appendConversation(agent, userId, role, message) — log to shared JSONL
//   - getRecentContext(userId, maxTurns, agent) — get last N turns for context injection
//   - formatContextForPrompt(userId, maxTurns, agent, perMsg, assistantLabel) — build prompt context
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
 * Get recent conversation context for a user
 * @param {string} userId - WeCom user ID
 * @param {number} maxTurns - Maximum number of entries to return (default 10)
 * @param {string|null} agent - If provided, only return entries from this agent
 *                              (avoids one bot reading another bot's history). null = all agents.
 * @returns {Array} Array of {ts, agent, role, message} objects
 */
function getRecentContext(userId, maxTurns = 10, agent = null) {
  ensureDir();
  if (!fs.existsSync(CONVERSATION_LOG)) return [];
  
  const lines = fs.readFileSync(CONVERSATION_LOG, 'utf8')
    .split('\n')
    .filter(Boolean);
  
  const userLines = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.userId === userId && (agent == null || entry.agent === agent)) {
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
 * @param {number} maxTurns - Max entries (default 6)
 * @param {string|null} agent - Restrict to this agent's history (default null = all)
 * @param {number} perMsg - Truncate each message to this many chars (default 300)
 * @param {string} assistantLabel - How to label assistant turns (default '助手')
 * @returns {string} Formatted context string (empty if no history)
 */
function formatContextForPrompt(userId, maxTurns = 6, agent = null, perMsg = 300, assistantLabel = '助手') {
  const entries = getRecentContext(userId, maxTurns, agent);
  if (entries.length === 0) return '';
  
  let ctx = '【历史对话】\n';
  for (const e of entries) {
    const who = e.role === 'user' ? '用户' : assistantLabel;
    const time = e.ts.slice(11, 16); // HH:MM
    ctx += `[${time}] ${who}: ${e.message.substring(0, perMsg)}\n`;
  }
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
