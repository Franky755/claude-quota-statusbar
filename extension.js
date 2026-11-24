const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';

const UI_TICK_MS = 15 * 1000;
const DEFAULT_API_TTL_MS = 60 * 1000;
const MANUAL_MIN_GAP_MS = 10 * 1000;
const FETCH_LOCK_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const MAX_STALE_QUOTA_MS = 30 * 60 * 1000;
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;

const I18N = {
  vi: {
    itemName: 'Hạn mức Claude',
    barSession: '5h',
    barWeekly: 'Tuần',
    barTodayFallback: 'Hôm nay',
    unitMin: 'p',
    unitHour: 'h',
    unitDay: 'ng',
    todayWord: 'hôm nay',
    resetting: 'đang đặt lại',
    unknownReset: 'chưa rõ',
    afterDaysHours: (d, h) => (h > 0 ? `sau ${d} ngày ${h} giờ` : `sau ${d} ngày`),
    afterHoursMins: (h, m) => (m > 0 ? `sau ${h} giờ ${m} phút` : `sau ${h} giờ`),
    afterMins: (m) => `sau ${m} phút`,
    tooltipTitle: '**Hạn mức tài khoản Claude**',
    rowSession: 'Phiên (5 giờ)',
    rowWeekly: 'Tuần (7 ngày)',
    rowScoped: (name) => `Tuần (${name})`,
    resetVerb: 'đặt lại',
    fallbackSuffix: 'đang hiển thị thống kê cục bộ',
    offlineDefault: 'Chưa lấy được phần trăm hạn mức trực tuyến',
    localHeader: '**Nhật ký máy cục bộ** *(vào + ra + ghi đệm)*',
    local5h: '5 giờ gần nhất',
    localToday: 'Hôm nay',
    tokIn: 'Vào',
    tokOut: 'Ra',
    tokCacheWrite: 'Ghi đệm',
    tokCacheRead: 'Đọc đệm',
    footer: (timeStr) => `*Cập nhật lúc ${timeStr} · Bấm để làm mới ngay*`,
    errReadFallback: 'Không thể đọc dữ liệu hạn mức. Bấm để thử lại.',
    scopedFallbackName: 'Mô hình phụ',
    notes: {
      noCredFile: 'Chưa tìm thấy thông tin đăng nhập Claude Code',
      noOauthToken: 'Chưa đăng nhập tài khoản Claude OAuth',
      tokenExpired: 'Phiên đăng nhập đã hết hạn, chờ Claude Code cấp mới',
      badEndpoint: 'Địa chỉ máy chủ không hợp lệ',
      schemaChanged: 'Định dạng dữ liệu hạn mức thay đổi',
      unreadableBody: 'Phản hồi máy chủ không đọc được',
      unauthorized: 'Phiên xác thực hết hiệu lực, chờ cập nhật lại',
      rateLimited: 'Đang dùng số lưu đệm do giới hạn lượt gọi',
      serverBusy: (code) => `Máy chủ hạn mức tạm bận (${code})`,
      timeout: 'Quá thời gian kết nối máy chủ hạn mức',
      networkError: 'Không có kết nối tới máy chủ hạn mức'
    }
  },
  en: {
    itemName: 'Claude Quota',
    barSession: '5h',
    barWeekly: 'Wk',
    barTodayFallback: 'Today',
    unitMin: 'm',
    unitHour: 'h',
    unitDay: 'd',
    todayWord: 'today',
    resetting: 'resetting soon',
    unknownReset: 'unknown',
    afterDaysHours: (d, h) => (h > 0 ? `in ${d}d ${h}h` : `in ${d}d`),
    afterHoursMins: (h, m) => (m > 0 ? `in ${h}h ${m}m` : `in ${h}h`),
    afterMins: (m) => `in ${m}m`,
    tooltipTitle: '**Claude Account Quota**',
    rowSession: 'Session (5h)',
    rowWeekly: 'Weekly (7d)',
    rowScoped: (name) => `Weekly (${name})`,
    resetVerb: 'resets',
    fallbackSuffix: 'showing local log stats',
    offlineDefault: 'Online quota unavailable',
    localHeader: '**Local CLI Logs** *(in + out + cache write)*',
    local5h: 'Last 5 hours',
    localToday: 'Today',
    tokIn: 'In',
    tokOut: 'Out',
    tokCacheWrite: 'Cache W',
    tokCacheRead: 'Cache R',
    footer: (timeStr) => `*Updated at ${timeStr} · Click to refresh*`,
    errReadFallback: 'Unable to read quota data. Click to retry.',
    scopedFallbackName: 'Scoped model',
    notes: {
      noCredFile: 'Claude Code credentials not found',
      noOauthToken: 'Not signed in with Claude OAuth',
      tokenExpired: 'OAuth token expired, waiting for Claude Code refresh',
      badEndpoint: 'Invalid API endpoint',
      schemaChanged: 'Unexpected quota response format',
      unreadableBody: 'Unreadable server response',
      unauthorized: 'Session expired, waiting for credential update',
      rateLimited: 'Showing cached quota (rate-limited)',
      serverBusy: (code) => `Quota endpoint temporarily unavailable (${code})`,
      timeout: 'Quota request timed out',
      networkError: 'Cannot reach Anthropic quota server'
    }
  }
};

function getClaudeDir() {
  const custom = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
  return custom || path.join(os.homedir(), '.claude');
}

function resolveLanguage(langSetting, vscodeLang = (vscode.env && vscode.env.language) || '') {
  if (langSetting === 'vi' || langSetting === 'en') return langSetting;
  const lower = String(vscodeLang).toLowerCase();
  if (lower.startsWith('vi')) return 'vi';
  try {
    const sysLocale = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
    if (sysLocale.startsWith('vi')) return 'vi';
  } catch {
    // Ignore locale lookup errors
  }
  return 'en';
}

function getExtensionSettings() {
  const cfg = vscode.workspace && vscode.workspace.getConfiguration
    ? vscode.workspace.getConfiguration('claudeQuota')
    : null;
  const get = (k, def) => (cfg ? cfg.get(k, def) : def);

  const warn = Math.max(50, Math.min(99, Number(get('warningThreshold', 80)) || 80));
  const err = Math.max(warn, Math.min(100, Number(get('errorThreshold', 95)) || 95));
  const ttlSec = Math.max(30, Math.min(600, Number(get('refreshIntervalSeconds', 60)) || 60));

  return {
    lang: resolveLanguage(get('language', 'auto')),
    showScopedOnStatusBar: Boolean(get('showScopedOnStatusBar', false)),
    warningThreshold: warn,
    errorThreshold: err,
    apiTtlMs: ttlSec * 1000,
    alignment: get('alignment', 'right') === 'left' ? 'left' : 'right'
  };
}

// Per-file mtime cache so scanning ~/.claude/projects/**/*.jsonl every 15s stays near-zero CPU
const jsonlFileCache = new Map();

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function listJsonl(dir, sinceMs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      listJsonl(p, sinceMs, out);
    } else if (e.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Ignore transient file deletions
      }
    }
  }
  return out;
}

function parseJsonlRecords(fileInfo) {
  const cached = jsonlFileCache.get(fileInfo.path);
  if (cached && cached.mtimeMs === fileInfo.mtimeMs && cached.size === fileInfo.size) {
    return cached.records;
  }
  let text;
  try {
    text = fs.readFileSync(fileInfo.path, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o.message && o.message.usage;
    if (!u || !o.timestamp) continue;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    records.push({
      key: (o.message.id || '') + ':' + (o.requestId || ''),
      ts,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0
    });
  }
  jsonlFileCache.set(fileInfo.path, {
    mtimeMs: fileInfo.mtimeMs,
    size: fileInfo.size,
    records
  });
  return records;
}

function collectLocalTokens(nowMs = Date.now(), projectsRoot = path.join(getClaudeDir(), 'projects')) {
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();
  const winStartMs = nowMs - WINDOW_5H_MS;
  const since = Math.min(startOfDayMs, winStartMs);

  const seen = new Set();
  const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const today = zero();
  const win = zero();

  const files = listJsonl(projectsRoot, since, []);
  const activePaths = new Set();

  for (const fileInfo of files) {
    activePaths.add(fileInfo.path);
    for (const r of parseJsonlRecords(fileInfo)) {
      if (r.key !== ':') {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
      }
      const add = (b) => {
        b.input += r.input;
        b.output += r.output;
        b.cacheWrite += r.cacheWrite;
        b.cacheRead += r.cacheRead;
      };
      if (r.ts >= startOfDayMs) add(today);
      if (r.ts >= winStartMs) add(win);
    }
  }

  if (jsonlFileCache.size > activePaths.size + 50) {
    for (const k of jsonlFileCache.keys()) {
      if (!activePaths.has(k)) jsonlFileCache.delete(k);
    }
  }

  return { today, win };
}

const freshTokens = (b) => b.input + b.output + b.cacheWrite;

function clampPercent(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return Math.max(0, Math.min(100, Math.round(val)));
}

function parseQuotaPayload(data, fallbackScopedLabel = 'Model') {
  if (!data || typeof data !== 'object') return null;

  const limits = Array.isArray(data.limits) ? data.limits : [];
  const sessionItem = limits.find((x) => x && (x.kind === 'session' || x.group === 'session'));
  const weeklyItem = limits.find((x) => x && x.kind === 'weekly_all');
  const scopedItems = limits.filter((x) => x && x.kind === 'weekly_scoped');

  const sessionPct = clampPercent(
    sessionItem ? sessionItem.percent : data.five_hour && data.five_hour.utilization
  );
  const weeklyPct = clampPercent(
    weeklyItem ? weeklyItem.percent : data.seven_day && data.seven_day.utilization
  );

  if (sessionPct === null && weeklyPct === null) return null;

  const session = sessionPct !== null ? {
    percent: sessionPct,
    resetsAt: (sessionItem && sessionItem.resets_at) || (data.five_hour && data.five_hour.resets_at) || null,
    severity: (sessionItem && sessionItem.severity) || 'normal'
  } : null;

  const weekly = weeklyPct !== null ? {
    percent: weeklyPct,
    resetsAt: (weeklyItem && weeklyItem.resets_at) || (data.seven_day && data.seven_day.resets_at) || null,
    severity: (weeklyItem && weeklyItem.severity) || 'normal'
  } : null;

  const scoped = [];
  if (scopedItems.length > 0) {
    for (const item of scopedItems) {
      const pct = clampPercent(item.percent);
      if (pct === null) continue;
      const rawName =
        (item.scope && item.scope.model && item.scope.model.display_name) ||
        (item.scope && item.scope.surface) ||
        fallbackScopedLabel;
      scoped.push({
        name: String(rawName),
        percent: pct,
        resetsAt: item.resets_at || null,
        severity: item.severity || 'normal'
      });
    }
  } else {
    // Legacy model sub-buckets fallback
    for (const [key, label] of [
      ['seven_day_fable', 'Fable'],
      ['seven_day_opus', 'Opus'],
      ['seven_day_sonnet', 'Sonnet']
    ]) {
      if (data[key] && typeof data[key].utilization === 'number') {
        const pct = clampPercent(data[key].utilization);
        if (pct !== null) {
          scoped.push({
            name: label,
            percent: pct,
            resetsAt: data[key].resets_at || null,
            severity: 'normal'
          });
        }
      }
    }
  }

  return { session, weekly, scoped };
}

function formatResetShort(resetsAtIso, nowMs = Date.now(), lang = 'vi') {
  const t = I18N[lang] || I18N.vi;
  if (!resetsAtIso) return '';
  const targetMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '';

  const totalMins = Math.max(1, Math.ceil(diffMs / 60000));
  if (totalMins >= 1440) {
    return `${Math.floor(totalMins / 1440)}${t.unitDay}`;
  }
  if (totalMins >= 360) {
    const roundedHours = Math.round(totalMins / 60);
    return roundedHours >= 24 ? `1${t.unitDay}` : `${roundedHours}${t.unitHour}`;
  }
  if (totalMins >= 60) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m === 0 ? `${h}${t.unitHour}` : `${h}${t.unitHour}${m}${t.unitMin}`;
  }
  return `${totalMins}${t.unitMin}`;
}

function formatClock(targetMs, nowMs = Date.now(), lang = 'vi') {
  const t = I18N[lang] || I18N.vi;
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');
  const sameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm} ${t.todayWord}`;
  const dd = String(target.getDate()).padStart(2, '0');
  const mo = String(target.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} ${dd}/${mo}`;
}

function formatResetLong(resetsAtIso, nowMs = Date.now(), lang = 'vi') {
  const t = I18N[lang] || I18N.vi;
  if (!resetsAtIso) return t.unknownReset;
  const targetMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(targetMs)) return t.unknownReset;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return t.resetting;

  const totalMins = Math.max(1, Math.ceil(diffMs / 60000));
  let rel;
  if (totalMins >= 1440) {
    const days = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    rel = t.afterDaysHours(days, hours);
  } else if (totalMins >= 60) {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    rel = t.afterHoursMins(hours, mins);
  } else {
    rel = t.afterMins(totalMins);
  }
  return `${rel} *(${formatClock(targetMs, nowMs, lang)})*`;
}

function renderBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function pickSeverityLevel(quota, warnPct = 80, errPct = 95) {
  if (!quota) return 'normal';
  const buckets = [quota.session, quota.weekly, ...(quota.scoped || [])].filter(Boolean);
  let maxPct = 0;
  for (const b of buckets) {
    if (typeof b.percent === 'number' && b.percent > maxPct) maxPct = b.percent;
    if (b.severity === 'critical' || b.severity === 'error') return 'error';
  }
  if (maxPct >= errPct) return 'error';
  if (maxPct >= warnPct || buckets.some((b) => b.severity === 'warning')) return 'warning';
  return 'normal';
}

function formatStatusBarText(quota, localTokens, nowMs = Date.now(), opts = {}) {
  const lang = opts.lang || 'vi';
  const t = I18N[lang] || I18N.vi;

  if (!quota || (!quota.session && !quota.weekly)) {
    const { today, win } = localTokens;
    return `$(pulse) ${t.barSession}: ${fmtTokens(freshTokens(win))} · ${t.barTodayFallback}: ${fmtTokens(freshTokens(today))}`;
  }

  const level = pickSeverityLevel(quota, opts.warningThreshold, opts.errorThreshold);
  const icon = level === 'normal' ? '$(pulse)' : '$(warning)';
  const parts = [];

  if (quota.session) {
    const rst = formatResetShort(quota.session.resetsAt, nowMs, lang);
    parts.push(`${t.barSession} ${quota.session.percent}%${rst ? ' ↻' + rst : ''}`);
  }
  if (quota.weekly) {
    const rst = formatResetShort(quota.weekly.resetsAt, nowMs, lang);
    parts.push(`${t.barWeekly} ${quota.weekly.percent}%${rst ? ' ↻' + rst : ''}`);
  }
  if (opts.showScopedOnStatusBar && Array.isArray(quota.scoped)) {
    for (const s of quota.scoped) {
      parts.push(`${s.name} ${s.percent}%`);
    }
  }

  return `${icon} ${parts.join(' · ')}`;
}

function resolveNoticeText(noticeKey, noticeArg, lang = 'vi') {
  if (!noticeKey) return null;
  const t = I18N[lang] || I18N.vi;
  const entry = t.notes[noticeKey];
  if (typeof entry === 'function') return entry(noticeArg);
  if (typeof entry === 'string') return entry;
  return null;
}

function buildTooltipMarkdown(quotaState, localTokens, nowMs = Date.now(), lang = 'vi') {
  const t = I18N[lang] || I18N.vi;
  const lines = [t.tooltipTitle, ''];
  const quota = quotaState && quotaState.quota;
  const notice = resolveNoticeText(
    quotaState && quotaState.noticeKey,
    quotaState && quotaState.noticeArg,
    lang
  );

  if (quota && (quota.session || quota.weekly)) {
    if (quota.session) {
      lines.push(
        `- **${t.rowSession}**: \`${renderBar(quota.session.percent)}\` **${quota.session.percent}%** — ${t.resetVerb} ${formatResetLong(quota.session.resetsAt, nowMs, lang)}`
      );
    }
    if (quota.weekly) {
      lines.push(
        `- **${t.rowWeekly}**: \`${renderBar(quota.weekly.percent)}\` **${quota.weekly.percent}%** — ${t.resetVerb} ${formatResetLong(quota.weekly.resetsAt, nowMs, lang)}`
      );
    }
    for (const s of quota.scoped || []) {
      lines.push(
        `- **${t.rowScoped(s.name)}**: \`${renderBar(s.percent)}\` **${s.percent}%** — ${t.resetVerb} ${formatResetLong(s.resetsAt, nowMs, lang)}`
      );
    }
    if (notice) {
      lines.push('', `*(${notice})*`);
    }
  } else {
    const reason = notice || t.offlineDefault;
    lines.push(`*(${reason} — ${t.fallbackSuffix})*`);
  }

  const { today, win } = localTokens;
  const fmtBreakdown = (b) =>
    `${t.tokIn} ${fmtTokens(b.input)} · ${t.tokOut} ${fmtTokens(b.output)} · ${t.tokCacheWrite} ${fmtTokens(b.cacheWrite)} · ${t.tokCacheRead} ${fmtTokens(b.cacheRead)}`;

  lines.push(
    '',
    '---',
    t.localHeader,
    `- **${t.local5h}**: **${fmtTokens(freshTokens(win))}** *(${fmtBreakdown(win)})*`,
    `- **${t.localToday}**: **${fmtTokens(freshTokens(today))}** *(${fmtBreakdown(today)})*`
  );

  const stampTime = quotaState && quotaState.fetchedAt ? new Date(quotaState.fetchedAt) : new Date(nowMs);
  const hh = String(stampTime.getHours()).padStart(2, '0');
  const mm = String(stampTime.getMinutes()).padStart(2, '0');
  const ss = String(stampTime.getSeconds()).padStart(2, '0');
  lines.push('', t.footer(`${hh}:${mm}:${ss}`));

  return lines.join('\n');
}

function readSharedCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeSharedCache(payload, cachePath) {
  const safePayload = {
    fetchedAt: payload.fetchedAt || 0,
    backoffUntil: payload.backoffUntil || 0,
    fetchingUntil: payload.fetchingUntil || 0,
    noticeKey: payload.noticeKey || null,
    noticeArg: payload.noticeArg || null,
    quota: payload.quota || null
  };
  const json = JSON.stringify(safePayload);
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch {
    try {
      fs.writeFileSync(cachePath, json, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Ignore write error on read-only fs
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
  }
}

function parseCredentialJsonString(rawJson, nowMs) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const oauth = parsed && parsed.claudeAiOauth;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!token) {
    return { token: null, noticeKey: 'noOauthToken' };
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt > 0 && oauth.expiresAt <= nowMs) {
    return { token: null, noticeKey: 'tokenExpired' };
  }
  return { token, noticeKey: null };
}

function readOauthAccessToken(options = {}) {
  const {
    credPath = path.join(getClaudeDir(), '.credentials.json'),
    nowMs = Date.now(),
    platform = process.platform,
    execKeychain = execFileSync
  } = options;

  // 1. Check standard dotfile (~/.claude/.credentials.json on Windows/Linux, or headless macOS fallback)
  try {
    if (fs.existsSync(credPath)) {
      const res = parseCredentialJsonString(fs.readFileSync(credPath, 'utf8'), nowMs);
      if (res && (res.token || res.noticeKey === 'tokenExpired')) {
        return res;
      }
    }
  } catch {
    // Fall through to macOS Keychain if applicable
  }

  // 2. Check macOS Keychain ('Claude Code-credentials')
  if (platform === 'darwin') {
    try {
      const secretOut = execKeychain(
        '/usr/bin/security',
        ['find-generic-password', '-s', MACOS_KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const res = parseCredentialJsonString(String(secretOut || '').trim(), nowMs);
      if (res) return res;
    } catch {
      return { token: null, noticeKey: 'noCredFile' };
    }
  }

  return { token: null, noticeKey: 'noCredFile' };
}

function requestUsageApi(token, requestImpl = https.request) {
  return new Promise((resolve) => {
    const url = new URL(USAGE_API_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'api.anthropic.com') {
      resolve({ ok: false, status: 0, retryAfterSec: 60, noticeKey: 'badEndpoint' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requestImpl(
      USAGE_API_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_BETA,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 256 * 1024) body += chunk;
        });
        res.on('end', () => {
          const code = res.statusCode || 0;
          const retryHeader = Number.parseInt(String((res.headers && res.headers['retry-after']) || ''), 10);

          if (code === 200) {
            try {
              const quota = parseQuotaPayload(JSON.parse(body));
              if (quota) {
                finish({ ok: true, quota });
              } else {
                finish({ ok: false, status: code, retryAfterSec: 60, noticeKey: 'schemaChanged' });
              }
            } catch {
              finish({ ok: false, status: code, retryAfterSec: 60, noticeKey: 'unreadableBody' });
            }
            return;
          }

          if (code === 401 || code === 403) {
            finish({ ok: false, status: code, retryAfterSec: 60, noticeKey: 'unauthorized' });
            return;
          }

          if (code === 429) {
            const waitSec = Number.isFinite(retryHeader)
              ? Math.max(60, Math.min(900, retryHeader))
              : 180;
            finish({ ok: false, status: code, retryAfterSec: waitSec, noticeKey: 'rateLimited' });
            return;
          }

          finish({ ok: false, status: code, retryAfterSec: 45, noticeKey: 'serverBusy', noticeArg: code });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, status: 0, retryAfterSec: 30, noticeKey: 'timeout' });
    });

    req.on('error', () => {
      finish({ ok: false, status: 0, retryAfterSec: 30, noticeKey: 'networkError' });
    });

    req.end();
  });
}

function hasPassedReset(quota, nowMs) {
  if (!quota) return false;
  const check = (b) => {
    if (!b || !b.resetsAt) return false;
    const t = Date.parse(b.resetsAt);
    return Number.isFinite(t) && t <= nowMs;
  };
  return check(quota.session) || check(quota.weekly);
}

async function fetchOrLoadQuota(options = {}) {
  const claudeDir = getClaudeDir();
  const {
    force = false,
    nowMs = Date.now(),
    apiTtlMs = DEFAULT_API_TTL_MS,
    credPath = path.join(claudeDir, '.credentials.json'),
    cachePath = path.join(claudeDir, 'usage-statusbar-cache.json'),
    platform = process.platform,
    execKeychain = execFileSync,
    requestImpl = https.request
  } = options;

  const cached = readSharedCache(cachePath);
  const cachedQuota = cached && cached.quota ? cached.quota : null;
  const cachedAgeMs = cached && cached.fetchedAt ? nowMs - cached.fetchedAt : Infinity;
  const usableCachedQuota = cachedAgeMs <= MAX_STALE_QUOTA_MS ? cachedQuota : null;

  if (!force && cached && cached.backoffUntil && cached.backoffUntil > nowMs) {
    return {
      quota: usableCachedQuota,
      fetchedAt: cached.fetchedAt || null,
      noticeKey: cached.noticeKey || null,
      noticeArg: cached.noticeArg || null
    };
  }

  const resetDue = hasPassedReset(usableCachedQuota, nowMs);
  const effectiveTtl = force ? MANUAL_MIN_GAP_MS : resetDue ? MANUAL_MIN_GAP_MS : apiTtlMs;

  if (usableCachedQuota && cachedAgeMs < effectiveTtl) {
    return {
      quota: usableCachedQuota,
      fetchedAt: cached.fetchedAt,
      noticeKey: cached.noticeKey || null,
      noticeArg: cached.noticeArg || null
    };
  }

  if (!force && cached && cached.fetchingUntil && cached.fetchingUntil > nowMs && usableCachedQuota) {
    return {
      quota: usableCachedQuota,
      fetchedAt: cached.fetchedAt,
      noticeKey: cached.noticeKey || null,
      noticeArg: cached.noticeArg || null
    };
  }

  const { token, noticeKey: credErr } = readOauthAccessToken({
    credPath,
    nowMs,
    platform,
    execKeychain
  });

  if (!token) {
    return {
      quota: usableCachedQuota,
      fetchedAt: (cached && cached.fetchedAt) || null,
      noticeKey: credErr,
      noticeArg: null
    };
  }

  writeSharedCache(
    {
      fetchedAt: (cached && cached.fetchedAt) || 0,
      backoffUntil: (cached && cached.backoffUntil) || 0,
      fetchingUntil: nowMs + FETCH_LOCK_MS,
      noticeKey: (cached && cached.noticeKey) || null,
      noticeArg: (cached && cached.noticeArg) || null,
      quota: usableCachedQuota
    },
    cachePath
  );

  const res = await requestUsageApi(token, requestImpl);
  const doneMs = Date.now();

  if (res.ok) {
    writeSharedCache(
      {
        fetchedAt: doneMs,
        backoffUntil: 0,
        fetchingUntil: 0,
        noticeKey: null,
        noticeArg: null,
        quota: res.quota
      },
      cachePath
    );
    return { quota: res.quota, fetchedAt: doneMs, noticeKey: null, noticeArg: null };
  }

  const nextBackoff = doneMs + (res.retryAfterSec || 60) * 1000;
  writeSharedCache(
    {
      fetchedAt: (cached && cached.fetchedAt) || 0,
      backoffUntil: nextBackoff,
      fetchingUntil: 0,
      noticeKey: res.noticeKey,
      noticeArg: res.noticeArg || null,
      quota: usableCachedQuota
    },
    cachePath
  );

  return {
    quota: usableCachedQuota,
    fetchedAt: (cached && cached.fetchedAt) || null,
    noticeKey: res.noticeKey,
    noticeArg: res.noticeArg || null
  };
}

function applyStatusBarStyle(item, quota, settings) {
  const level = pickSeverityLevel(quota, settings.warningThreshold, settings.errorThreshold);
  if (level === 'error') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (level === 'warning') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    item.backgroundColor = undefined;
  }
}

function createBarItem(alignment) {
  const side =
    alignment === 'left'
      ? vscode.StatusBarAlignment.Left
      : vscode.StatusBarAlignment.Right;
  const priority = alignment === 'left' ? 100 : 1000;
  const item = vscode.window.createStatusBarItem(side, priority);
  item.command = 'claudeQuota.refresh';
  return item;
}

function activate(context) {
  let settings = getExtensionSettings();
  let currentAlignment = settings.alignment;
  let item = createBarItem(currentAlignment);
  item.name = (I18N[settings.lang] || I18N.vi).itemName;

  const cachePath = path.join(getClaudeDir(), 'usage-statusbar-cache.json');

  try {
    const initialTokens = collectLocalTokens();
    const initialCache = readSharedCache(cachePath);
    const initialQuota =
      initialCache && initialCache.quota && Date.now() - (initialCache.fetchedAt || 0) <= MAX_STALE_QUOTA_MS
        ? initialCache.quota
        : null;
    item.text = formatStatusBarText(initialQuota, initialTokens, Date.now(), settings);
    applyStatusBarStyle(item, initialQuota, settings);
    item.tooltip = new vscode.MarkdownString(
      buildTooltipMarkdown(
        {
          quota: initialQuota,
          fetchedAt: initialCache && initialCache.fetchedAt,
          noticeKey: initialCache && initialCache.noticeKey,
          noticeArg: initialCache && initialCache.noticeArg
        },
        initialTokens,
        Date.now(),
        settings.lang
      )
    );
  } catch {
    item.text = `$(pulse) ${(I18N[settings.lang] || I18N.vi).itemName}`;
  }
  item.show();

  let busy = false;
  const update = async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      settings = getExtensionSettings();
      if (settings.alignment !== currentAlignment) {
        currentAlignment = settings.alignment;
        item.dispose();
        item = createBarItem(currentAlignment);
        item.show();
      }
      item.name = (I18N[settings.lang] || I18N.vi).itemName;

      const localTokens = collectLocalTokens();
      const quotaState = await fetchOrLoadQuota({
        force,
        apiTtlMs: settings.apiTtlMs
      });
      const nowMs = Date.now();
      item.text = formatStatusBarText(quotaState.quota, localTokens, nowMs, settings);
      applyStatusBarStyle(item, quotaState.quota, settings);
      item.tooltip = new vscode.MarkdownString(
        buildTooltipMarkdown(quotaState, localTokens, nowMs, settings.lang)
      );
    } catch {
      const t = I18N[settings.lang] || I18N.vi;
      item.text = `$(warning) ${t.itemName}`;
      item.backgroundColor = undefined;
      item.tooltip = new vscode.MarkdownString(t.errReadFallback);
    } finally {
      busy = false;
    }
  };

  update(false);
  const timer = setInterval(() => update(false), UI_TICK_MS);

  const configSub =
    vscode.workspace && vscode.workspace.onDidChangeConfiguration
      ? vscode.workspace.onDidChangeConfiguration((ev) => {
          if (!ev || !ev.affectsConfiguration || ev.affectsConfiguration('claudeQuota')) {
            update(false);
          }
        })
      : { dispose() {} };

  context.subscriptions.push(
    { dispose: () => item.dispose() },
    { dispose: () => clearInterval(timer) },
    configSub,
    vscode.commands.registerCommand('claudeQuota.refresh', () => update(true))
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internal: {
    resolveLanguage,
    parseQuotaPayload,
    formatResetShort,
    formatResetLong,
    formatStatusBarText,
    buildTooltipMarkdown,
    pickSeverityLevel,
    readOauthAccessToken,
    fetchOrLoadQuota,
    collectLocalTokens
  }
};

