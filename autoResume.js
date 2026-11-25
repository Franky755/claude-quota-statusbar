// Auto-resume for Claude Code sessions that stopped on a usage limit.
// Only sessions that are still running (registered in ~/.claude/sessions and whose PID is alive) are considered.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TAIL_BYTES = 256 * 1024;
const LIMIT_ERROR = 'usage_limit_reached';

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else
    return Boolean(err && err.code === 'EPERM');
  }
}

async function listRunningSessions(claudeDir, isAlive = isPidAlive) {
  const dir = path.join(claudeDir, 'sessions');
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let data;
    try {
      data = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data.sessionId !== 'string' || !isAlive(data.pid)) continue;
    out.push({
      pid: data.pid,
      sessionId: data.sessionId,
      cwd: typeof data.cwd === 'string' ? data.cwd : '',
      name: typeof data.name === 'string' && data.name ? data.name : data.sessionId.slice(0, 8),
      status: typeof data.status === 'string' ? data.status : 'unknown',
      entrypoint: typeof data.entrypoint === 'string' ? data.entrypoint : 'cli'
    });
  }
  return out;
}

// Session transcripts live in projects/<encoded cwd>/<sessionId>.jsonl; the encoding is not
// a stable contract, so look the file up by name and remember where it was.
const transcriptPathCache = new Map();

async function findTranscript(claudeDir, sessionId) {
  const cached = transcriptPathCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const root = path.join(claudeDir, 'projects');
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcriptPathCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

async function readTail(filePath, maxBytes = TAIL_BYTES) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the first (possibly truncated) line when we did not start at the beginning
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

// Looks at the last conversational record. A session is waiting on a limit when that record is
// the usage-limit API error; any later user/assistant record means it already moved on.
function parseLimitState(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || (o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
    if (o.type === 'assistant' && o.apiError === LIMIT_ERROR) {
      const info = (o.apiErrorParams && o.apiErrorParams.rate_limit_info) || o.quotaLimits || {};
      const resetsAtSec = Number(info.resetsAt);
      return {
        limited: true,
        resetsAtMs: Number.isFinite(resetsAtSec) && resetsAtSec > 0 ? resetsAtSec * 1000 : null,
        limitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
        limitedAt: Date.parse(o.timestamp) || null
      };
    }
    return { limited: false };
  }
  return { limited: false };
}

function normalizePath(p, platform = process.platform) {
  let out = path.resolve(String(p || ''));
  if (platform === 'win32') out = out.toLowerCase();
  return out.replace(/[\\/]+$/, '');
}

function isInsideFolders(cwd, folders, platform = process.platform) {
  if (!cwd || !Array.isArray(folders) || !folders.length) return false;
  const target = normalizePath(cwd, platform);
  const sep = platform === 'win32' ? '\\' : path.sep;
  return folders.some((f) => {
    const root = normalizePath(f, platform);
    return target === root || target.startsWith(root + sep) || target.startsWith(root + '/');
  });
}

function quotaStillBlocked(quota, limitType) {
  if (!quota) return false;
  const bucket = limitType && /seven|week/i.test(limitType) ? quota.weekly : quota.session;
  return Boolean(bucket && typeof bucket.percent === 'number' && bucket.percent >= 100);
}

// Pure decision step: which limited sessions should be resumed right now.
function planAutoResume({ sessions, mode, selected, resumed, quota, nowMs, delayMs }) {
  if (mode === 'off') return [];
  const picked = new Set(selected || []);
  const done = resumed || {};
  const due = [];
  for (const s of sessions || []) {
    if (!s.limit || !s.limit.limited || !s.limit.resetsAtMs) continue;
    if (mode !== 'all' && !picked.has(s.sessionId)) continue;
    if (s.status !== 'idle') continue;
    if (nowMs < s.limit.resetsAtMs + (delayMs || 0)) continue;
    if (done[`${s.sessionId}|${s.limit.resetsAtMs}`]) continue;
    if (quotaStillBlocked(quota, s.limit.limitType)) continue;
    due.push(s);
  }
  return due;
}

// Per-session message wins over the global default; blank entries fall back too
function resolveResumeMessage(sessionId, messages, defaultMessage) {
  const own = messages && typeof messages[sessionId] === 'string' ? messages[sessionId].trim() : '';
  return own || String(defaultMessage || '').trim() || 'continue';
}

// The Claude TUI submits on newline, so a multi-line message must go in as one line
function toSingleLine(message) {
  return String(message || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function execFileText(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function getParentPid(pid, platform = process.platform) {
  if (platform === 'win32') {
    const out = await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`
    ]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const out = await execFileText('ps', ['-o', 'ppid=', '-p', String(Number(pid))]);
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Walks up the process tree of a CLI session until it meets a terminal's shell PID.
async function findTerminalForPid(pid, terminals, getParent = getParentPid, maxDepth = 5) {
  const byPid = new Map();
  for (const term of terminals || []) {
    let shellPid;
    try {
      shellPid = await term.processId;
    } catch {
      shellPid = null;
    }
    if (shellPid) byPid.set(shellPid, term);
  }
  if (!byPid.size) return null;
  let current = pid;
  for (let depth = 0; depth < maxDepth && current; depth++) {
    if (byPid.has(current)) return byPid.get(current);
    current = await getParent(current);
  }
  return null;
}

module.exports = {
  LIMIT_ERROR,
  isPidAlive,
  listRunningSessions,
  findTranscript,
  readTail,
  parseLimitState,
  isInsideFolders,
  quotaStillBlocked,
  planAutoResume,
  resolveResumeMessage,
  toSingleLine,
  getParentPid,
  findTerminalForPid
};
