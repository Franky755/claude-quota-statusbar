const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const autoResume = require('./autoResume');

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_PAGE_URL = 'https://claude.ai/settings/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const EXTENSION_ID = 'Franky755.claude-quota-statusbar';

const UI_TICK_MS = 15 * 1000;
const DEFAULT_API_TTL_MS = 60 * 1000;
const MANUAL_MIN_GAP_MS = 10 * 1000;
const FETCH_LOCK_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const MAX_STALE_QUOTA_MS = 30 * 60 * 1000;
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;

// Usage history kept in the shared cache to project burn rate
const HISTORY_SAMPLE_GAP_MS = 5 * 60 * 1000;
const HISTORY_KEEP_MS = 26 * 60 * 60 * 1000;
const HISTORY_MAX = 400;
// Weekly percentages move in whole-percent steps, so they need a longer baseline to avoid noisy projections
const FORECAST_MIN_SPAN_MS = { session: 10 * 60 * 1000, weekly: 3 * 60 * 60 * 1000 };
const FORECAST_LOOKBACK_MS = { session: 2 * 60 * 60 * 1000, weekly: 24 * 60 * 60 * 1000 };
const RESET_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

const NOTIFIED_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const LEVEL_RANK = { warning: 1, error: 2 };
const SIGNED_OUT_NOTICES = new Set(['noCredFile', 'noOauthToken']);

const SUPPORTED_LANGS = ['en', 'vi', 'zh-cn', 'ja', 'ko', 'es', 'pt-br', 'fr', 'de', 'ru'];
const DEFAULT_LANG = 'en';
const I18N_DIR = path.join(__dirname, 'i18n');

// USD per million tokens: [model id substring, input, output, cache read].
// Ordered most specific first. Cache writes are billed at 1.25x (5m) / 2x (1h) input.
const MODEL_PRICING = [
  ['fable-5-1', 10, 50, 0.25],
  ['fable', 10, 50, 1],
  ['mythos', 10, 50, 1],
  ['opus-5-5', 4, 20, 0.2],
  ['opus-5', 5, 25, 0.5],
  ['opus-4-1', 15, 75, 1.5],
  ['opus-4-0', 15, 75, 1.5],
  ['opus-4-2', 15, 75, 1.5],
  ['3-opus', 15, 75, 1.5],
  ['opus', 5, 25, 0.5],
  ['sonnet-5-5', 2, 10, 0.2],
  ['sonnet-5', 2, 10, 0.2],
  ['sonnet', 3, 15, 0.3],
  ['haiku-5-5', 0.1, 0.5, 0.01],
  ['haiku-4-5', 1, 5, 0.1],
  ['3-5-haiku', 0.8, 4, 0.08],
  ['haiku', 1, 5, 0.1]
];

let logChannel = null;

function log(level, message) {
  if (!logChannel) return;
  try {
    if (typeof logChannel[level] === 'function') logChannel[level](message);
    else logChannel.appendLine(`[${level}] ${message}`);
  } catch {
    // Ignore logging failures
  }
}

const localeCache = new Map();
const translatorCache = new Map();

function loadLocale(lang) {
  if (localeCache.has(lang)) return localeCache.get(lang);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8'));
  } catch {
    // Missing or broken locale file falls back to English per key
  }
  localeCache.set(lang, data);
  return data;
}

function getTranslator(lang) {
  const key = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
  if (translatorCache.has(key)) return translatorCache.get(key);
  const strings = loadLocale(key);
  const base = loadLocale(DEFAULT_LANG);
  const t = (id, ...args) => {
    const raw = typeof strings[id] === 'string' ? strings[id] : typeof base[id] === 'string' ? base[id] : id;
    if (!args.length) return raw;
    return raw.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
  };
  t.lang = key;
  t.locale = strings._locale || base._locale || 'en-US';
  t.has = (id) => typeof strings[id] === 'string' || typeof base[id] === 'string';
  translatorCache.set(key, t);
  return t;
}

function getClaudeDir() {
  const custom = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
  return custom || path.join(os.homedir(), '.claude');
}

function matchSupportedLang(tag) {
  const lower = String(tag || '').toLowerCase().replace(/_/g, '-');
  if (!lower) return null;
  if (SUPPORTED_LANGS.includes(lower)) return lower;
  const primary = lower.split('-')[0];
  if (primary === 'zh') return 'zh-cn';
  if (primary === 'pt') return 'pt-br';
  return SUPPORTED_LANGS.includes(primary) ? primary : null;
}

function resolveLanguage(langSetting, vscodeLang = (vscode.env && vscode.env.language) || '', sysLocale) {
  if (langSetting && langSetting !== 'auto' && SUPPORTED_LANGS.includes(langSetting)) return langSetting;
  const fromVscode = matchSupportedLang(vscodeLang);
  if (fromVscode && fromVscode !== DEFAULT_LANG) return fromVscode;
  // VS Code ships in English by default, so a non-English OS locale is a stronger signal
  let sys = sysLocale;
  if (sys === undefined) {
    try {
      sys = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      sys = '';
    }
  }
  return matchSupportedLang(sys) || fromVscode || DEFAULT_LANG;
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
    alignment: get('alignment', 'right') === 'left' ? 'left' : 'right',
    notifications: Boolean(get('notifications', true)),
    clickAction: get('clickAction', 'menu') === 'refresh' ? 'refresh' : 'menu',
    format: String(get('statusBarFormat', '') || ''),
    showCostEstimate: Boolean(get('showCostEstimate', true)),
    hideWhenSignedOut: Boolean(get('hideWhenSignedOut', false)),
    autoResume: ['off', 'selected', 'all'].includes(get('autoResume', 'selected')) ? get('autoResume', 'selected') : 'selected',
    autoResumeMessage: String(get('autoResumeMessage', 'continue') || '').trim() || 'continue',
    autoResumeDelayMs: Math.max(0, Math.min(1800, Number(get('autoResumeDelaySeconds', 60)) || 0)) * 1000
  };
}

// Per-file read offset cache: each 15s tick only reads bytes appended since the last scan
const jsonlFileCache = new Map();

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUsd(n) {
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

async function listJsonl(dir, sinceMs, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await listJsonl(p, sinceMs, out);
    } else if (e.name.endsWith('.jsonl')) {
      try {
        const st = await fs.promises.stat(p);
        if (st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Ignore transient file deletions
      }
    }
  }
  return out;
}

function parseUsageLine(line) {
  if (!line.includes('"usage"')) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const u = o.message && o.message.usage;
  if (!u || !o.timestamp) return null;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return null;
  const model = typeof o.message.model === 'string' ? o.message.model : '';
  return {
    key: (o.message.id || '') + ':' + (o.requestId || ''),
    ts,
    model: model && !model.startsWith('<') ? model : '',
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheWrite1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    cacheRead: u.cache_read_input_tokens || 0
  };
}

async function readRange(filePath, start, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } finally {
    await fh.close();
  }
}

async function readJsonlRecords(fileInfo) {
  const cached = jsonlFileCache.get(fileInfo.path);
  if (cached && cached.mtimeMs === fileInfo.mtimeMs && cached.size === fileInfo.size) {
    return cached.records;
  }
  // Logs are append-only; a shrunk file means it was rewritten, so parse from scratch
  const canAppend = cached && fileInfo.size >= cached.offset;
  const records = canAppend ? cached.records : [];
  let offset = canAppend ? cached.offset : 0;

  const length = fileInfo.size - offset;
  if (length > 0) {
    let buf;
    try {
      buf = await readRange(fileInfo.path, offset, length);
    } catch {
      return cached ? cached.records : [];
    }
    // Only consume complete lines so a half-written record (or split UTF-8 char) is re-read next tick
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      for (const line of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
        const r = parseUsageLine(line);
        if (r) records.push(r);
      }
      offset += lastNl + 1;
    }
  }

  jsonlFileCache.set(fileInfo.path, {
    mtimeMs: fileInfo.mtimeMs,
    size: fileInfo.size,
    offset,
    records
  });
  return records;
}

const zeroBucket = () => ({ input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });

function addToBucket(b, r) {
  b.input += r.input;
  b.output += r.output;
  b.cacheWrite += r.cacheWrite;
  b.cacheWrite1h += r.cacheWrite1h;
  b.cacheRead += r.cacheRead;
}

async function collectLocalTokens(nowMs = Date.now(), projectsRoot = path.join(getClaudeDir(), 'projects')) {
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayMs = startOfDay.getTime();
  const winStartMs = nowMs - WINDOW_5H_MS;
  const since = Math.min(startOfDayMs, winStartMs);

  const seen = new Set();
  const today = zeroBucket();
  const win = zeroBucket();
  const byModel = new Map();

  const files = await listJsonl(projectsRoot, since, []);
  const activePaths = new Set();

  for (const fileInfo of files) {
    activePaths.add(fileInfo.path);
    for (const r of await readJsonlRecords(fileInfo)) {
      if (r.key !== ':') {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
      }
      if (r.ts >= startOfDayMs) {
        addToBucket(today, r);
        if (r.model) {
          if (!byModel.has(r.model)) byModel.set(r.model, zeroBucket());
          addToBucket(byModel.get(r.model), r);
        }
      }
      if (r.ts >= winStartMs) addToBucket(win, r);
    }
  }

  if (jsonlFileCache.size > activePaths.size + 50) {
    for (const k of jsonlFileCache.keys()) {
      if (!activePaths.has(k)) jsonlFileCache.delete(k);
    }
  }

  return {
    today,
    win,
    byModel: [...byModel.entries()].map(([model, b]) => ({ model, ...b }))
  };
}

const freshTokens = (b) => b.input + b.output + b.cacheWrite;

function findModelPricing(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  const hit = MODEL_PRICING.find(([match]) => id.includes(match));
  return hit ? { input: hit[1], output: hit[2], cacheRead: hit[3] } : null;
}

function estimateCostUsd(bucket, model) {
  const p = findModelPricing(model);
  if (!p) return null;
  const write1h = Math.min(bucket.cacheWrite1h || 0, bucket.cacheWrite || 0);
  const write5m = (bucket.cacheWrite || 0) - write1h;
  return (
    (bucket.input || 0) * p.input +
    (bucket.output || 0) * p.output +
    write5m * p.input * 1.25 +
    write1h * p.input * 2 +
    (bucket.cacheRead || 0) * p.cacheRead
  ) / 1e6;
}

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

function formatResetShort(resetsAtIso, nowMs = Date.now(), lang = DEFAULT_LANG) {
  const t = getTranslator(lang);
  if (!resetsAtIso) return '';
  const targetMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '';

  const unitMin = t('unitMin');
  const unitHour = t('unitHour');
  const unitDay = t('unitDay');
  const totalMins = Math.max(1, Math.ceil(diffMs / 60000));
  if (totalMins >= 1440) {
    return `${Math.floor(totalMins / 1440)}${unitDay}`;
  }
  if (totalMins >= 360) {
    const roundedHours = Math.round(totalMins / 60);
    return roundedHours >= 24 ? `1${unitDay}` : `${roundedHours}${unitHour}`;
  }
  if (totalMins >= 60) {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m === 0 ? `${h}${unitHour}` : `${h}${unitHour}${m}${unitMin}`;
  }
  return `${totalMins}${unitMin}`;
}

function formatTime(date, locale, withSeconds = false) {
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (withSeconds) opts.second = '2-digit';
  try {
    return new Intl.DateTimeFormat(locale, opts).format(date);
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
  }
}

function formatClock(targetMs, nowMs = Date.now(), lang = DEFAULT_LANG) {
  const t = getTranslator(lang);
  const target = new Date(targetMs);
  const now = new Date(nowMs);
  const time = formatTime(target, t.locale);
  const sameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  if (sameDay) return `${time} ${t('todayWord')}`;
  let date;
  try {
    date = new Intl.DateTimeFormat(t.locale, { day: '2-digit', month: '2-digit' }).format(target);
  } catch {
    date = `${String(target.getDate()).padStart(2, '0')}/${String(target.getMonth() + 1).padStart(2, '0')}`;
  }
  return `${time} ${date}`;
}

// Returns { rel, clock } where clock is null when there is no concrete reset time
function formatResetParts(resetsAtIso, nowMs = Date.now(), lang = DEFAULT_LANG) {
  const t = getTranslator(lang);
  if (!resetsAtIso) return { rel: t('unknownReset'), clock: null };
  const targetMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(targetMs)) return { rel: t('unknownReset'), clock: null };
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return { rel: t('resetting'), clock: null };

  const totalMins = Math.max(1, Math.ceil(diffMs / 60000));
  let rel;
  if (totalMins >= 1440) {
    const days = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    rel = hours > 0 ? t('afterDaysHours', days, hours) : t('afterDays', days);
  } else if (totalMins >= 60) {
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    rel = mins > 0 ? t('afterHoursMins', hours, mins) : t('afterHours', hours);
  } else {
    rel = t('afterMins', totalMins);
  }
  return { rel, clock: formatClock(targetMs, nowMs, lang) };
}

function formatResetLong(resetsAtIso, nowMs = Date.now(), lang = DEFAULT_LANG) {
  const { rel, clock } = formatResetParts(resetsAtIso, nowMs, lang);
  return clock ? `${rel} *(${clock})*` : rel;
}

function renderBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function quotaBuckets(quota) {
  if (!quota) return [];
  return [quota.session, quota.weekly, ...(quota.scoped || [])].filter(Boolean);
}

function maxPercent(quota) {
  let max = 0;
  for (const b of quotaBuckets(quota)) {
    if (typeof b.percent === 'number' && b.percent > max) max = b.percent;
  }
  return max;
}

function pickSeverityLevel(quota, warnPct = 80, errPct = 95) {
  if (!quota) return 'normal';
  const buckets = quotaBuckets(quota);
  if (buckets.some((b) => b.severity === 'critical' || b.severity === 'error')) return 'error';
  const maxPct = maxPercent(quota);
  if (maxPct >= errPct) return 'error';
  if (maxPct >= warnPct || buckets.some((b) => b.severity === 'warning')) return 'warning';
  return 'normal';
}

function applyFormatTemplate(template, values) {
  return String(template)
    .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatStatusBarText(quota, localTokens, nowMs = Date.now(), opts = {}) {
  const lang = opts.lang || DEFAULT_LANG;
  const t = getTranslator(lang);

  if (!quota || (!quota.session && !quota.weekly)) {
    const { today, win } = localTokens;
    return `$(pulse) ${t('barSession')}: ${fmtTokens(freshTokens(win))} · ${t('barTodayFallback')}: ${fmtTokens(freshTokens(today))}`;
  }

  const level = pickSeverityLevel(quota, opts.warningThreshold, opts.errorThreshold);
  const icon = level === 'normal' ? '$(pulse)' : '$(warning)';
  const sessionReset = quota.session ? formatResetShort(quota.session.resetsAt, nowMs, lang) : '';
  const weeklyReset = quota.weekly ? formatResetShort(quota.weekly.resetsAt, nowMs, lang) : '';

  if (opts.format && opts.format.trim()) {
    return applyFormatTemplate(opts.format, {
      icon,
      session: quota.session ? quota.session.percent : '–',
      sessionReset,
      weekly: quota.weekly ? quota.weekly.percent : '–',
      weeklyReset,
      scoped: (quota.scoped || []).map((s) => `${s.name} ${s.percent}%`).join(' · '),
      max: maxPercent(quota)
    });
  }

  const parts = [];
  if (quota.session) {
    parts.push(`${t('barSession')} ${quota.session.percent}%${sessionReset ? ' ↻' + sessionReset : ''}`);
  }
  if (quota.weekly) {
    parts.push(`${t('barWeekly')} ${quota.weekly.percent}%${weeklyReset ? ' ↻' + weeklyReset : ''}`);
  }
  if (opts.showScopedOnStatusBar && Array.isArray(quota.scoped)) {
    for (const s of quota.scoped) {
      parts.push(`${s.name} ${s.percent}%`);
    }
  }

  return `${icon} ${parts.join(' · ')}`;
}

function resolveNoticeText(noticeKey, noticeArg, lang = DEFAULT_LANG) {
  if (!noticeKey) return null;
  const t = getTranslator(lang);
  const id = `note.${noticeKey}`;
  if (!t.has(id)) return null;
  return t(id, noticeArg === null || noticeArg === undefined ? '' : noticeArg);
}

function appendHistory(history, quota, nowMs) {
  const list = Array.isArray(history)
    ? history.filter((h) => h && Number.isFinite(h.t) && h.t <= nowMs && nowMs - h.t <= HISTORY_KEEP_MS)
    : [];
  if (!quota) return list;
  const sample = {
    t: nowMs,
    s: quota.session ? quota.session.percent : null,
    sr: quota.session ? quota.session.resetsAt : null,
    w: quota.weekly ? quota.weekly.percent : null,
    wr: quota.weekly ? quota.weekly.resetsAt : null
  };
  const last = list[list.length - 1];
  if (last && nowMs - last.t < HISTORY_SAMPLE_GAP_MS && last.s === sample.s && last.w === sample.w) {
    return list;
  }
  list.push(sample);
  return list.slice(-HISTORY_MAX);
}

// Linear projection from the oldest sample in the same reset window
function computeForecast(history, kind, bucket, nowMs = Date.now()) {
  if (!bucket || !bucket.resetsAt || !Array.isArray(history)) return null;
  if (bucket.percent >= 100) return null;
  const resetMs = Date.parse(bucket.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;

  const pk = kind === 'session' ? 's' : 'w';
  const rk = kind === 'session' ? 'sr' : 'wr';
  const lookback = FORECAST_LOOKBACK_MS[kind] || FORECAST_LOOKBACK_MS.session;
  const points = history.filter((h) => {
    if (!h || typeof h[pk] !== 'number' || h.t > nowMs || h.t < nowMs - lookback) return false;
    const r = Date.parse(h[rk]);
    return Number.isFinite(r) && Math.abs(r - resetMs) <= RESET_MATCH_TOLERANCE_MS;
  });
  if (!points.length) return null;

  const oldest = points.reduce((a, b) => (b.t < a.t ? b : a));
  const span = nowMs - oldest.t;
  const delta = bucket.percent - oldest[pk];
  if (span < (FORECAST_MIN_SPAN_MS[kind] || FORECAST_MIN_SPAN_MS.session) || delta <= 0) return null;

  const rate = delta / span;
  const hitMs = nowMs + (100 - bucket.percent) / rate;
  if (hitMs < resetMs) return { type: 'hit', atMs: hitMs };
  return { type: 'ok', percent: Math.min(100, Math.round(bucket.percent + rate * (resetMs - nowMs))) };
}

function formatForecast(forecast, nowMs, lang) {
  if (!forecast) return null;
  const t = getTranslator(lang);
  if (forecast.type === 'hit') return t('forecastHit', formatClock(forecast.atMs, nowMs, lang));
  return t('forecastOk', forecast.percent);
}

function buildTooltipMarkdown(quotaState, localTokens, nowMs = Date.now(), lang = DEFAULT_LANG, opts = {}) {
  const t = getTranslator(lang);
  const lines = [`**${t('tooltipTitle')}**`, ''];
  const quota = quotaState && quotaState.quota;
  const history = (quotaState && quotaState.history) || [];
  const notice = resolveNoticeText(
    quotaState && quotaState.noticeKey,
    quotaState && quotaState.noticeArg,
    lang
  );

  const row = (label, bucket, kind) => {
    const { rel, clock } = formatResetParts(bucket.resetsAt, nowMs, lang);
    const reset = clock ? `${t('resetsIn', rel)} *(${clock})*` : rel;
    lines.push(`- **${label}**: \`${renderBar(bucket.percent)}\` **${bucket.percent}%** — ${reset}`);
    const forecast = kind ? formatForecast(computeForecast(history, kind, bucket, nowMs), nowMs, lang) : null;
    if (forecast) lines.push(`  - *${forecast}*`);
  };

  if (quota && (quota.session || quota.weekly)) {
    if (quota.session) row(t('rowSession'), quota.session, 'session');
    if (quota.weekly) row(t('rowWeekly'), quota.weekly, 'weekly');
    for (const s of quota.scoped || []) row(t('rowScoped', s.name), s, null);
    if (notice) {
      lines.push('', `*(${notice})*`);
    }
  } else {
    const reason = notice || t('offlineDefault');
    lines.push(`*(${reason} — ${t('fallbackSuffix')})*`);
  }

  const { today, win } = localTokens;
  const fmtBreakdown = (b) =>
    `${t('tokIn')} ${fmtTokens(b.input)} · ${t('tokOut')} ${fmtTokens(b.output)} · ${t('tokCacheWrite')} ${fmtTokens(b.cacheWrite)} · ${t('tokCacheRead')} ${fmtTokens(b.cacheRead)}`;

  lines.push(
    '',
    '---',
    `**${t('localHeader')}** *(${t('localHeaderHint')})*`,
    `- **${t('local5h')}**: **${fmtTokens(freshTokens(win))}** *(${fmtBreakdown(win)})*`,
    `- **${t('localToday')}**: **${fmtTokens(freshTokens(today))}** *(${fmtBreakdown(today)})*`
  );

  const models = Array.isArray(localTokens.byModel) ? localTokens.byModel : [];
  if (opts.showCost !== false && models.length > 0) {
    lines.push('', `**${t('modelHeader')}** *(${t('costHint')})*`);
    let total = 0;
    let priced = false;
    const sorted = [...models].sort((a, b) => freshTokens(b) - freshTokens(a));
    for (const m of sorted) {
      const cost = estimateCostUsd(m, m.model);
      if (cost !== null) {
        total += cost;
        priced = true;
      }
      const name = m.model.replace(/^claude-/, '');
      lines.push(`- \`${name}\`: **${fmtTokens(freshTokens(m))}**${cost !== null ? ` · ≈ ${fmtUsd(cost)}` : ''}`);
    }
    if (priced && sorted.length > 1) {
      lines.push(`- **${t('costTotal')}**: ≈ **${fmtUsd(total)}**`);
    }
  }

  // Always say whether auto-resume is armed, so it can be checked before walking away
  const arMode = opts.autoResumeMode || 'off';
  const arSessions = opts.autoResumeSessions || [];
  const limited = arSessions.filter((s) => s.limit && s.limit.limited);
  if (arMode !== 'off' || limited.length > 0) {
    const status =
      arMode === 'all'
        ? t('autoResumeStatusAll')
        : arMode === 'selected'
          ? t('autoResumeStatusSelected', arSessions.filter((s) => s.willResume).length)
          : t('autoResumeStatusOff');
    lines.push('', `**${t('autoResumeHeader')}**: ${status}`);
    for (const s of limited) {
      const at = s.limit.resetsAtMs
        ? formatClock(s.limit.resetsAtMs + (s.willResume ? opts.autoResumeDelayMs || 0 : 0), nowMs, lang)
        : t('unknownReset');
      // Only custom messages are worth showing; the default "continue" is implied
      const msg = s.willResume && s.customMessage ? ` → \`${truncate(s.message, 60).replace(/`/g, "'")}\`` : '';
      lines.push(`- ${t(s.willResume ? 'autoResumeWaiting' : 'autoResumeNotSelected', s.name, at)}${msg}`);
    }
  }

  const stampTime = quotaState && quotaState.fetchedAt ? new Date(quotaState.fetchedAt) : new Date(nowMs);
  const stamp = formatTime(stampTime, t.locale, true);
  lines.push('', `*${t(opts.clickAction === 'refresh' ? 'footerRefresh' : 'footer', stamp)}*`);

  return lines.join('\n');
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function markdownToPlain(md) {
  return md
    .split('\n')
    .filter((line) => line.trim() !== '---')
    .join('\n')
    .replace(/\*\*|\*|`/g, '')
    .trim();
}

function shouldHideItem(quotaState, settings) {
  if (!settings.hideWhenSignedOut) return false;
  const quota = quotaState && quotaState.quota;
  if (quota && (quota.session || quota.weekly)) return false;
  return SIGNED_OUT_NOTICES.has(quotaState && quotaState.noticeKey);
}

// Decides which buckets crossed a threshold that has not been announced yet in this reset window
function planNotifications(quota, notified, warnPct, errPct, nowMs = Date.now()) {
  const next = {};
  for (const [key, entry] of Object.entries(notified || {})) {
    if (!entry || !LEVEL_RANK[entry.level]) continue;
    const resetMs = Date.parse(key.slice(key.lastIndexOf('|') + 1));
    if (Number.isFinite(resetMs) && resetMs <= nowMs) continue;
    if (!Number.isFinite(entry.at) || nowMs - entry.at > NOTIFIED_KEEP_MS) continue;
    next[key] = entry;
  }

  const candidates = [];
  if (quota && quota.session) candidates.push({ id: 'session', bucket: quota.session });
  if (quota && quota.weekly) candidates.push({ id: 'weekly', bucket: quota.weekly });
  for (const s of (quota && quota.scoped) || []) {
    candidates.push({ id: `scoped:${s.name}`, name: s.name, bucket: s });
  }

  const due = [];
  for (const c of candidates) {
    const pct = c.bucket.percent;
    const level = pct >= errPct ? 'error' : pct >= warnPct ? 'warning' : null;
    if (!level) continue;
    const key = `${c.id}|${c.bucket.resetsAt || 'none'}`;
    const prev = next[key];
    if (prev && LEVEL_RANK[prev.level] >= LEVEL_RANK[level]) continue;
    next[key] = { level, at: nowMs };
    due.push({ id: c.id, name: c.name, level, percent: pct, resetsAt: c.bucket.resetsAt });
  }

  due.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.percent - a.percent);
  return { due, notified: next };
}

function readJsonFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const json = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, json, { encoding: 'utf8', mode: 0o600 });
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

function readSharedCache(cachePath) {
  return readJsonFile(cachePath);
}

function writeSharedCache(payload, cachePath) {
  writeJsonAtomic(cachePath, {
    fetchedAt: payload.fetchedAt || 0,
    backoffUntil: payload.backoffUntil || 0,
    fetchingUntil: payload.fetchingUntil || 0,
    noticeKey: payload.noticeKey || null,
    noticeArg: payload.noticeArg || null,
    quota: payload.quota || null,
    history: Array.isArray(payload.history) ? payload.history : []
  });
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
          Accept: 'application/json'
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
                finish({ ok: true, status: code, quota });
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

// True only while a bucket's reset time has passed and we have not fetched since then,
// so a stale resets_at from the API cannot cause a fast-retry loop.
function hasPassedReset(quota, nowMs, fetchedAt = 0) {
  if (!quota) return false;
  const check = (b) => {
    if (!b || !b.resetsAt) return false;
    const t = Date.parse(b.resetsAt);
    return Number.isFinite(t) && t <= nowMs && (fetchedAt || 0) < t;
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
  const history = (cached && Array.isArray(cached.history)) ? cached.history : [];

  const fromCache = () => ({
    quota: usableCachedQuota,
    fetchedAt: (cached && cached.fetchedAt) || null,
    noticeKey: (cached && cached.noticeKey) || null,
    noticeArg: (cached && cached.noticeArg) || null,
    history,
    fresh: false
  });

  if (!force && cached && cached.backoffUntil && cached.backoffUntil > nowMs) {
    return fromCache();
  }

  const resetDue = hasPassedReset(usableCachedQuota, nowMs, cached && cached.fetchedAt);
  const effectiveTtl = force || resetDue ? MANUAL_MIN_GAP_MS : apiTtlMs;

  if (usableCachedQuota && cachedAgeMs < effectiveTtl) {
    return fromCache();
  }

  if (!force && cached && cached.fetchingUntil && cached.fetchingUntil > nowMs && usableCachedQuota) {
    return fromCache();
  }

  const { token, noticeKey: credErr } = readOauthAccessToken({
    credPath,
    nowMs,
    platform,
    execKeychain
  });

  if (!token) {
    log('warn', `No usable OAuth token (${credErr})`);
    return { ...fromCache(), noticeKey: credErr, noticeArg: null };
  }

  writeSharedCache(
    {
      fetchedAt: (cached && cached.fetchedAt) || 0,
      backoffUntil: (cached && cached.backoffUntil) || 0,
      fetchingUntil: nowMs + FETCH_LOCK_MS,
      noticeKey: (cached && cached.noticeKey) || null,
      noticeArg: (cached && cached.noticeArg) || null,
      quota: usableCachedQuota,
      history
    },
    cachePath
  );

  const res = await requestUsageApi(token, requestImpl);
  const doneMs = Date.now();

  if (res.ok) {
    const nextHistory = appendHistory(history, res.quota, doneMs);
    writeSharedCache(
      {
        fetchedAt: doneMs,
        backoffUntil: 0,
        fetchingUntil: 0,
        noticeKey: null,
        noticeArg: null,
        quota: res.quota,
        history: nextHistory
      },
      cachePath
    );
    log('info', `Usage API HTTP 200: session ${res.quota.session ? res.quota.session.percent : '-'}%, weekly ${res.quota.weekly ? res.quota.weekly.percent : '-'}%`);
    return { quota: res.quota, fetchedAt: doneMs, noticeKey: null, noticeArg: null, history: nextHistory, fresh: true };
  }

  const nextBackoff = doneMs + (res.retryAfterSec || 60) * 1000;
  log('warn', `Usage API HTTP ${res.status || 'n/a'} (${res.noticeKey}); backing off ${res.retryAfterSec || 60}s`);
  writeSharedCache(
    {
      fetchedAt: (cached && cached.fetchedAt) || 0,
      backoffUntil: nextBackoff,
      fetchingUntil: 0,
      noticeKey: res.noticeKey,
      noticeArg: res.noticeArg || null,
      quota: usableCachedQuota,
      history
    },
    cachePath
  );

  return { ...fromCache(), noticeKey: res.noticeKey, noticeArg: res.noticeArg || null };
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
  return vscode.window.createStatusBarItem(side, priority);
}

function activate(context) {
  logChannel = vscode.window.createOutputChannel
    ? vscode.window.createOutputChannel('Claude Quota', { log: true })
    : null;

  let settings = getExtensionSettings();
  let currentAlignment = settings.alignment;
  let item = createBarItem(currentAlignment);

  const claudeDir = getClaudeDir();
  const cachePath = path.join(claudeDir, 'usage-statusbar-cache.json');
  const notifiedPath = path.join(claudeDir, 'usage-statusbar-notified.json');
  const resumedPath = path.join(claudeDir, 'usage-statusbar-resumed.json');
  const SELECTED_KEY = 'autoResume.selectedSessions';
  const MESSAGES_KEY = 'autoResume.sessionMessages';

  let lastState = { quota: null, fetchedAt: null, noticeKey: null, noticeArg: null, history: [] };
  let lastTokens = { today: zeroBucket(), win: zeroBucket(), byModel: [] };
  let lastSessions = [];

  const getSelected = () => {
    const raw = context.globalState && context.globalState.get(SELECTED_KEY);
    return Array.isArray(raw) ? raw : [];
  };
  const getMessages = () => {
    const raw = context.globalState && context.globalState.get(MESSAGES_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  };
  const messageFor = (sessionId) =>
    autoResume.resolveResumeMessage(sessionId, getMessages(), settings.autoResumeMessage);

  const tooltipOpts = () => ({
    showCost: settings.showCostEstimate,
    clickAction: settings.clickAction,
    autoResumeSessions: lastSessions,
    autoResumeMode: settings.autoResume,
    autoResumeDelayMs: settings.autoResumeDelayMs
  });

  // Running Claude Code sessions whose working directory belongs to this window
  const scanSessions = async () => {
    const folders = ((vscode.workspace && vscode.workspace.workspaceFolders) || []).map((f) => f.uri.fsPath);
    if (!folders.length) return [];
    const running = await autoResume.listRunningSessions(claudeDir);
    const selected = new Set(getSelected());
    const out = [];
    for (const s of running) {
      if (!autoResume.isInsideFolders(s.cwd, folders)) continue;
      let limit = { limited: false };
      const transcript = await autoResume.findTranscript(claudeDir, s.sessionId);
      if (transcript) {
        try {
          limit = autoResume.parseLimitState(await autoResume.readTail(transcript));
        } catch {
          // Transcript rotated or unreadable; treat as not limited
        }
      }
      const willResume =
        settings.autoResume === 'all' || (settings.autoResume === 'selected' && selected.has(s.sessionId));
      const own = getMessages()[s.sessionId];
      out.push({ ...s, limit, willResume, message: messageFor(s.sessionId), customMessage: Boolean(own && own.trim()) });
    }
    return out;
  };

  const resumeSession = async (s) => {
    const t = getTranslator(settings.lang);
    const message = messageFor(s.sessionId);
    if (s.entrypoint === 'cli') {
      const term = await autoResume.findTerminalForPid(s.pid, vscode.window.terminals || []);
      if (!term) {
        log('warn', `Auto-resume: no terminal found for session ${s.sessionId} (pid ${s.pid})`);
        vscode.window.showWarningMessage(t('resumeNoTerminal', s.name));
        return;
      }
      term.sendText(autoResume.toSingleLine(message), false);
      // Submit separately so the TUI does not treat the text and Enter as one paste
      setTimeout(() => term.sendText('\r', false), 300);
      log('info', `Auto-resume: sent resume message (${message.length} chars) to terminal session ${s.sessionId}`);
      vscode.window.showInformationMessage(t('resumedTerminal', s.name));
      return;
    }
    // The Claude Code panel has no public "send prompt" API; open the session with the prompt pre-filled
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', s.sessionId, message);
    log('info', `Auto-resume: opened panel session ${s.sessionId} with prompt pre-filled`);
    vscode.window.showInformationMessage(t('resumedPanel', s.name, message));
  };

  const runAutoResume = async (sessions, quota) => {
    const resumed = readJsonFile(resumedPath) || {};
    const nowMs = Date.now();
    const due = autoResume.planAutoResume({
      sessions,
      mode: settings.autoResume,
      selected: getSelected(),
      resumed,
      quota,
      nowMs,
      delayMs: settings.autoResumeDelayMs
    });
    if (!due.length) return;
    // Record before acting so other windows (or the next tick) never resume the same limit twice
    for (const [k, at] of Object.entries(resumed)) {
      if (!Number.isFinite(at) || nowMs - at > NOTIFIED_KEEP_MS) delete resumed[k];
    }
    for (const s of due) resumed[`${s.sessionId}|${s.limit.resetsAtMs}`] = nowMs;
    writeJsonAtomic(resumedPath, resumed);
    for (const s of due) {
      try {
        await resumeSession(s);
      } catch (err) {
        log('error', `Auto-resume failed for ${s.sessionId}: ${err && err.message ? err.message : err}`);
      }
    }
  };

  const setAutoResumeMode = async (mode) => {
    if (settings.autoResume === mode) return;
    await vscode.workspace.getConfiguration('claudeQuota').update('autoResume', mode, vscode.ConfigurationTarget.Global);
    settings = getExtensionSettings();
  };

  // Step 1: one global choice. Only "pick sessions" leads to a second step.
  const manageAutoResume = async () => {
    const t = getTranslator(settings.lang);
    const current = (mode) => (settings.autoResume === mode ? ` ${t('autoResumeCurrent')}` : '');
    const modes = [
      { mode: 'all', label: `$(check-all) ${t('autoResumeModeAll')}${current('all')}`, detail: t('autoResumeModeAllDetail') },
      { mode: 'selected', label: `$(checklist) ${t('autoResumeModeSelected')}${current('selected')}`, detail: t('autoResumeModeSelectedDetail') },
      { mode: 'off', label: `$(circle-slash) ${t('autoResumeModeOffLabel')}${current('off')}` }
    ];
    const choice = await vscode.window.showQuickPick(modes, {
      title: t('autoResumeModeTitle'),
      placeHolder: t('autoResumePanelNote')
    });
    if (!choice) return;
    await setAutoResumeMode(choice.mode);
    if (choice.mode !== 'selected') {
      update(false);
      return;
    }
    await pickAutoResumeSessions();
  };

  const pickAutoResumeSessions = async () => {
    const t = getTranslator(settings.lang);
    lastSessions = await scanSessions();
    if (!lastSessions.length) {
      vscode.window.showInformationMessage(t('autoResumeNoSessions'));
      return;
    }
    const running = new Set((await autoResume.listRunningSessions(claudeDir)).map((s) => s.sessionId));
    const messages = {};
    for (const [id, msg] of Object.entries(getMessages())) {
      if (running.has(id)) messages[id] = msg;
    }

    // Tick + OK is the whole flow; the pencil button is an optional custom message per session
    const pickSessions = (picked) =>
      new Promise((resolve) => {
        const qp = vscode.window.createQuickPick();
        qp.canSelectMany = true;
        qp.placeholder = t('autoResumePickTitle');
        qp.items = lastSessions.map((s) => ({
          label: s.name,
          description: `${path.basename(s.cwd)} · ${s.entrypoint === 'cli' ? 'terminal' : 'panel'} · ${s.status}`,
          detail: [
            s.limit.limited && s.limit.resetsAtMs
              ? t('autoResumeLimited', formatClock(s.limit.resetsAtMs, Date.now(), settings.lang))
              : null,
            messages[s.sessionId] ? t('autoResumeMessageDetail', truncate(messages[s.sessionId], 80)) : null
          ].filter(Boolean).join(' · ') || undefined,
          buttons: [{ iconPath: new vscode.ThemeIcon('edit'), tooltip: t('autoResumeEditMessage') }],
          sessionId: s.sessionId
        }));
        qp.selectedItems = qp.items.filter((i) => picked.has(i.sessionId));
        let result = null;
        qp.onDidTriggerItemButton((e) => {
          result = { edit: e.item, picked: new Set(qp.selectedItems.map((i) => i.sessionId)) };
          qp.hide();
        });
        qp.onDidAccept(() => {
          result = { done: qp.selectedItems };
          qp.hide();
        });
        qp.onDidHide(() => {
          qp.dispose();
          resolve(result);
        });
        qp.show();
      });

    let picked = new Set(getSelected());
    let picks;
    for (;;) {
      const r = await pickSessions(picked);
      if (!r) return;
      if (r.done) {
        picks = r.done;
        break;
      }
      // Giving a session a message implies it should be resumed
      picked = r.picked;
      picked.add(r.edit.sessionId);
      const value = await vscode.window.showInputBox({
        title: t('autoResumeMessageTitle', r.edit.label),
        prompt: t('autoResumeMessagePrompt'),
        placeHolder: settings.autoResumeMessage,
        value: messages[r.edit.sessionId] || '',
        ignoreFocusOut: true
      });
      if (value === undefined) continue;
      if (!value.trim() || value.trim() === settings.autoResumeMessage) delete messages[r.edit.sessionId];
      else messages[r.edit.sessionId] = value.trim();
    }

    // Keep choices for sessions that are not open in this window
    const visible = new Set(lastSessions.map((s) => s.sessionId));
    const next = getSelected().filter((id) => !visible.has(id) && running.has(id));
    for (const p of picks) next.push(p.sessionId);
    await context.globalState.update(SELECTED_KEY, next);
    await context.globalState.update(MESSAGES_KEY, messages);

    update(false);
  };

  const render = (quotaState, localTokens, nowMs) => {
    const t = getTranslator(settings.lang);
    item.name = t('itemName');
    item.command = settings.clickAction === 'refresh' ? 'claudeQuota.refresh' : 'claudeQuota.showMenu';
    item.text = formatStatusBarText(quotaState.quota, localTokens, nowMs, settings);
    applyStatusBarStyle(item, quotaState.quota, settings);
    item.tooltip = new vscode.MarkdownString(
      buildTooltipMarkdown(quotaState, localTokens, nowMs, settings.lang, tooltipOpts())
    );
    if (shouldHideItem(quotaState, settings)) item.hide();
    else item.show();
  };

  try {
    const initialCache = readSharedCache(cachePath);
    const initialQuota =
      initialCache && initialCache.quota && Date.now() - (initialCache.fetchedAt || 0) <= MAX_STALE_QUOTA_MS
        ? initialCache.quota
        : null;
    lastState = {
      quota: initialQuota,
      fetchedAt: initialCache && initialCache.fetchedAt,
      noticeKey: initialCache && initialCache.noticeKey,
      noticeArg: initialCache && initialCache.noticeArg,
      history: (initialCache && initialCache.history) || []
    };
    render(lastState, lastTokens, Date.now());
  } catch {
    item.text = `$(pulse) ${getTranslator(settings.lang)('itemName')}`;
    item.show();
  }

  const showSpinner = () => {
    item.text = `$(sync~spin) ${getTranslator(settings.lang)('refreshing')}`;
  };

  const notifyThresholds = (quota) => {
    const t = getTranslator(settings.lang);
    const { due, notified } = planNotifications(
      quota,
      readJsonFile(notifiedPath) || {},
      settings.warningThreshold,
      settings.errorThreshold,
      Date.now()
    );
    if (!due.length) return;
    writeJsonAtomic(notifiedPath, notified);

    const top = due[0];
    const label =
      top.id === 'session' ? t('rowSession') : top.id === 'weekly' ? t('rowWeekly') : t('rowScoped', top.name);
    const { rel, clock } = formatResetParts(top.resetsAt, Date.now(), settings.lang);
    const when = clock ? `${rel} (${clock})` : rel;
    const message = t(top.level === 'error' ? 'notifyError' : 'notifyWarning', label, top.percent, when);
    const show = top.level === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    log('info', `Threshold alert: ${top.id} ${top.percent}% (${top.level})`);

    Promise.resolve(show(message, t('notifyOpenUsage'), t('notifyDisable'))).then((choice) => {
      if (choice === t('notifyOpenUsage')) {
        vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE_URL));
      } else if (choice === t('notifyDisable')) {
        vscode.workspace
          .getConfiguration('claudeQuota')
          .update('notifications', false, vscode.ConfigurationTarget.Global);
      }
    }, () => {});
  };

  let busy = false;
  let pending = null;
  const update = async (force = false) => {
    if (busy) {
      // Queue instead of dropping, so a click during a background tick still refreshes
      pending = pending === true || force;
      if (force) showSpinner();
      return;
    }
    busy = true;
    try {
      settings = getExtensionSettings();
      if (settings.alignment !== currentAlignment) {
        currentAlignment = settings.alignment;
        item.dispose();
        item = createBarItem(currentAlignment);
      }
      if (force) showSpinner();

      const localTokens = await collectLocalTokens();
      const quotaState = await fetchOrLoadQuota({
        force,
        apiTtlMs: settings.apiTtlMs
      });
      lastState = quotaState;
      lastTokens = localTokens;
      lastSessions = settings.autoResume === 'off' ? [] : await scanSessions();
      render(quotaState, localTokens, Date.now());

      if (quotaState.fresh && settings.notifications && quotaState.quota) {
        notifyThresholds(quotaState.quota);
      }
      if (lastSessions.length) await runAutoResume(lastSessions, quotaState.quota);
    } catch (err) {
      log('error', `Update failed: ${err && err.message ? err.message : err}`);
      const t = getTranslator(settings.lang);
      item.text = `$(warning) ${t('itemName')}`;
      item.backgroundColor = undefined;
      item.tooltip = new vscode.MarkdownString(t('errReadFallback'));
      item.show();
    } finally {
      busy = false;
      if (pending !== null) {
        const nextForce = pending;
        pending = null;
        update(nextForce);
      }
    }
  };

  const showMenu = async () => {
    const t = getTranslator(settings.lang);
    const items = [
      { id: 'refresh', label: `$(refresh) ${t('menuRefresh')}` },
      { id: 'usage', label: `$(link-external) ${t('menuUsagePage')}` },
      { id: 'autoResume', label: `$(debug-restart) ${t('menuAutoResume')}` },
      { id: 'copy', label: `$(copy) ${t('menuCopy')}` },
      { id: 'settings', label: `$(gear) ${t('menuSettings')}` },
      { id: 'log', label: `$(output) ${t('menuLog')}` }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('menuPlaceholder') });
    if (!pick) return;
    if (pick.id === 'refresh') {
      update(true);
    } else if (pick.id === 'usage') {
      vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE_URL));
    } else if (pick.id === 'autoResume') {
      await manageAutoResume();
    } else if (pick.id === 'copy') {
      const md = buildTooltipMarkdown(lastState, lastTokens, Date.now(), settings.lang, tooltipOpts());
      const lines = markdownToPlain(md).split('\n');
      await vscode.env.clipboard.writeText(lines.slice(0, -1).join('\n').trim());
      vscode.window.showInformationMessage(t('copied'));
    } else if (pick.id === 'settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
    } else if (pick.id === 'log' && logChannel) {
      logChannel.show(true);
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
    vscode.commands.registerCommand('claudeQuota.refresh', () => update(true)),
    vscode.commands.registerCommand('claudeQuota.showMenu', showMenu),
    vscode.commands.registerCommand('claudeQuota.showLog', () => logChannel && logChannel.show(true)),
    vscode.commands.registerCommand('claudeQuota.manageAutoResume', manageAutoResume)
  );
  if (logChannel) context.subscriptions.push(logChannel);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internal: {
    SUPPORTED_LANGS,
    getTranslator,
    resolveLanguage,
    parseQuotaPayload,
    formatResetShort,
    formatResetLong,
    formatResetParts,
    formatClock,
    formatStatusBarText,
    buildTooltipMarkdown,
    pickSeverityLevel,
    readOauthAccessToken,
    fetchOrLoadQuota,
    collectLocalTokens,
    estimateCostUsd,
    findModelPricing,
    appendHistory,
    computeForecast,
    planNotifications,
    shouldHideItem,
    hasPassedReset,
    markdownToPlain
  }
};
