// Renders README feature images from the extension's real formatting functions.
// Usage: node scripts/generate-screenshots.js   (set CHROME_PATH if Chrome/Edge is not auto-detected)
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return { env: { language: 'en' } };
  return origLoad.apply(this, arguments);
};
const { _internal: ext } = require('../extension.js');

const OUT_DIR = path.join(__dirname, '..', 'images');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 25, 14, 20, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

const quotaNormal = {
  session: { percent: 42, resetsAt: iso(NOW + 2 * HOUR + 35 * MIN), severity: 'normal' },
  weekly: { percent: 57, resetsAt: iso(NOW + 4 * 24 * HOUR + 16 * HOUR), severity: 'normal' },
  scoped: [{ name: 'Fable', percent: 10, resetsAt: iso(NOW + 4 * 24 * HOUR + 16 * HOUR), severity: 'normal' }]
};
const quotaWarn = {
  ...quotaNormal,
  session: { percent: 86, resetsAt: iso(NOW + 1 * HOUR + 40 * MIN), severity: 'normal' }
};
const quotaErr = {
  ...quotaNormal,
  session: { percent: 97, resetsAt: iso(NOW + 25 * MIN), severity: 'normal' }
};

const history = [
  { t: NOW - 20 * HOUR, s: null, sr: null, w: 52, wr: quotaWarn.weekly.resetsAt },
  { t: NOW - 50 * MIN, s: 58, sr: quotaWarn.session.resetsAt, w: 56, wr: quotaWarn.weekly.resetsAt },
  { t: NOW - 25 * MIN, s: 72, sr: quotaWarn.session.resetsAt, w: 56, wr: quotaWarn.weekly.resetsAt }
];

const local = {
  win: { input: 182000, output: 412000, cacheWrite: 5100000, cacheWrite1h: 3900000, cacheRead: 41000000 },
  today: { input: 506000, output: 1210000, cacheWrite: 14800000, cacheWrite1h: 11000000, cacheRead: 162000000 },
  byModel: [
    { model: 'claude-opus-5-5', input: 380000, output: 940000, cacheWrite: 11200000, cacheWrite1h: 9000000, cacheRead: 121000000 },
    { model: 'claude-sonnet-5-5', input: 104000, output: 230000, cacheWrite: 3100000, cacheWrite1h: 2000000, cacheRead: 36000000 },
    { model: 'claude-haiku-5-5', input: 22000, output: 40000, cacheWrite: 500000, cacheWrite1h: 0, cacheRead: 5000000 }
  ]
};

const autoResumeSessions = [
  { name: 'api-refactor', willResume: true, customMessage: true, message: 'Run the test suite first, then finish the migration', limit: { limited: true, resetsAtMs: NOW + 40 * MIN } },
  { name: 'docs-site', willResume: false, limit: { limited: true, resetsAtMs: NOW + 40 * MIN } }
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(md) {
  return esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// Minimal renderer for the markdown subset the tooltip uses
function renderMarkdown(md) {
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push('</ul>');
    list = null;
  };
  for (const line of md.split('\n')) {
    if (line.trim() === '---') {
      closeList();
      out.push('<hr>');
    } else if (/^ {2}- /.test(line)) {
      out.push(`<li class="sub">${inline(line.slice(4))}</li>`);
    } else if (/^- /.test(line)) {
      if (!list) {
        out.push('<ul>');
        list = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

const icon = (text) =>
  esc(text).replace(/\$\(([\w-]+)(~spin)?\)/g, (m, name, spin) => `<i class="codicon codicon-${name}${spin ? ' spin' : ''}"></i>`);

const CSS = `
:root { --bg:#1f1f1f; --sb:#181818; --fg:#cccccc; --muted:#9d9d9d; --border:#2b2b2b; --widget:#202020; --wborder:#454545; --accent:#0078d4; --warn:#9e6a03; --err:#c72e0f; }
* { box-sizing: border-box; }
body { margin:0; background:#0d1117; font: 13px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; color:var(--fg); }
.frame { position:relative; background:var(--bg); border:1px solid #30363d; border-radius:10px; overflow:hidden; }
.title { height:30px; background:#181818; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:7px; padding:0 12px; }
.dot { width:11px; height:11px; border-radius:50%; background:#3c3c3c; }
.title span { margin-left:10px; font-size:12px; color:var(--muted); }
.editor { padding:14px 18px; font: 13px/1.6 Consolas, "Cascadia Code", monospace; color:#6a9955; }
.statusbar { height:24px; background:var(--sb); border-top:1px solid var(--border); display:flex; justify-content:flex-end; align-items:stretch; font-size:12px; }
.statusbar .left { margin-right:auto; display:flex; }
.sbi { display:flex; align-items:center; gap:4px; padding:0 8px; white-space:nowrap; color:var(--fg); }
.sbi.quota { color:#fff; }
.sbi.warning { background:var(--warn); }
.sbi.error { background:var(--err); }
.sbi.hover { background:#ffffff1f; }
.codicon { font-size:14px; }
.spin { animation:none; }
.hover-widget { position:absolute; background:var(--widget); border:1px solid var(--wborder); border-radius:6px; box-shadow:0 4px 18px #000a; padding:8px 14px; width:560px; font-size:13px; }
.hover-widget p { margin:4px 0; }
.hover-widget ul { margin:4px 0; padding-left:18px; }
.hover-widget li { margin:2px 0; }
.hover-widget li.sub { list-style:none; margin-left:12px; color:var(--muted); }
.hover-widget code { font-family: Consolas, monospace; background:#ffffff14; padding:0 3px; border-radius:3px; letter-spacing:-0.5px; }
.hover-widget hr { border:0; border-top:1px solid var(--wborder); margin:8px 0; }
.hover-widget em { color:var(--muted); font-style:italic; }
.row { display:flex; align-items:center; gap:14px; margin:10px 0; }
.label { width:150px; color:var(--muted); font-size:12px; text-align:right; }
.strip { flex:1; height:24px; background:var(--sb); border:1px solid var(--border); border-radius:4px; display:flex; justify-content:flex-end; overflow:hidden; }
.quickpick { position:absolute; left:50%; transform:translateX(-50%); top:44px; width:560px; background:#222; border:1px solid var(--wborder); border-radius:8px; box-shadow:0 8px 28px #000c; padding:6px; }
.qp-input { border:1px solid var(--accent); border-radius:4px; padding:5px 8px; color:var(--muted); margin-bottom:6px; background:#313131; }
.qp-item { display:flex; align-items:flex-start; gap:8px; padding:5px 8px; border-radius:4px; }
.qp-item.active { background:#04395e; outline:1px solid var(--accent); }
.qp-item .desc { color:var(--muted); font-size:12px; margin-left:6px; }
.qp-item .detail { color:var(--muted); font-size:12px; }
.check { width:16px; height:16px; border:1px solid #6b6b6b; border-radius:3px; margin-top:2px; flex:none; display:flex; align-items:center; justify-content:center; font-size:12px; }
.check.on { background:var(--accent); border-color:var(--accent); color:#fff; }
.toast { position:absolute; right:14px; width:450px; background:#252526; border:1px solid var(--wborder); border-radius:6px; box-shadow:0 6px 22px #000c; padding:12px 14px; }
.toast .msg { display:flex; gap:9px; }
.toast .msg .codicon { font-size:16px; margin-top:1px; }
.toast .src { color:var(--muted); font-size:12px; margin:8px 0 0 25px; }
.toast .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
.btn { background:var(--accent); color:#fff; padding:3px 12px; border-radius:3px; font-size:12px; }
.btn.secondary { background:#3a3d41; }
.caption { position:absolute; left:16px; top:42px; font-size:12px; color:var(--muted); }
`;

const page = (body, width, height) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css">
<style>${CSS} body{width:${width}px;height:${height}px;padding:16px;}</style></head><body>${body}</body></html>`;

const windowChrome = (title, inner, statusItems, height) => `
<div class="frame" style="height:${height}px">
  <div class="title"><div class="dot"></div><div class="dot"></div><div class="dot"></div><span>${esc(title)}</span></div>
  ${inner}
  <div class="statusbar" style="position:absolute;bottom:0;left:0;right:0">
    <div class="left"><div class="sbi"><i class="codicon codicon-source-control"></i> main</div><div class="sbi"><i class="codicon codicon-error"></i> 0 <i class="codicon codicon-warning"></i> 0</div></div>
    ${statusItems}
    <div class="sbi">Ln 42, Col 7</div><div class="sbi">UTF-8</div><div class="sbi"><i class="codicon codicon-bell"></i></div>
  </div>
</div>`;

const sbOpts = (lang, extra = {}) => ({ lang, warningThreshold: 80, errorThreshold: 95, ...extra });

function quotaItem(quota, opts, cls = '') {
  const level = ext.pickSeverityLevel(quota, 80, 95);
  const text = ext.formatStatusBarText(quota, local, NOW, opts);
  return `<div class="sbi quota ${level === 'normal' ? '' : level} ${cls}">${icon(text)}</div>`;
}

const images = [];

// 1. Status bar states, languages and custom format
{
  const rows = [
    ['Normal', quotaItem(quotaNormal, sbOpts('en'))],
    ['Warning ≥ 80%', quotaItem(quotaWarn, sbOpts('en'))],
    ['Critical ≥ 95%', quotaItem(quotaErr, sbOpts('en'))],
    ['Model-scoped on bar', quotaItem(quotaNormal, sbOpts('en', { showScopedOnStatusBar: true }))],
    ['Custom format', quotaItem(quotaNormal, sbOpts('en', { format: '{icon} Claude {max}% · ↻{sessionReset}' }))],
    ['Tiếng Việt', quotaItem(quotaNormal, sbOpts('vi'))],
    ['日本語', quotaItem(quotaNormal, sbOpts('ja'))],
    ['Deutsch', quotaItem(quotaNormal, sbOpts('de'))],
    ['简体中文', quotaItem(quotaNormal, sbOpts('zh-cn'))],
    ['Offline fallback', quotaItem(null, sbOpts('en'))]
  ];
  const body = `<div class="frame" style="padding:14px 18px 8px">${rows
    .map(([label, item]) => `<div class="row"><div class="label">${esc(label)}</div><div class="strip">${item}</div></div>`)
    .join('')}</div>`;
  images.push({ name: 'statusbar.png', html: page(body, 760, 404), width: 760, height: 404 });
}

// 2. Rich tooltip with forecast, per-model cost and auto-resume section
{
  const md = ext.buildTooltipMarkdown(
    { quota: quotaWarn, fetchedAt: NOW - 20 * 1000, history },
    local,
    NOW,
    'en',
    { showCost: true, autoResumeSessions, autoResumeMode: 'selected', autoResumeDelayMs: MIN }
  );
  const inner = `<div class="editor">// hover the quota item for details</div>
  <div class="hover-widget" style="right:24px;bottom:30px">${renderMarkdown(md)}</div>`;
  const items = quotaItem(quotaWarn, sbOpts('en'), 'hover');
  const height = 600;
  images.push({ name: 'tooltip.png', html: page(windowChrome('Claude Code — api-refactor', inner, items, height), 900, height + 32), width: 900, height: height + 32 });
}

// 3. Quick menu + threshold alert
{
  const items = [
    ['refresh', 'Refresh now', true],
    ['link-external', 'Open Claude usage page'],
    ['debug-restart', 'Auto-resume limited sessions…'],
    ['copy', 'Copy quota summary'],
    ['gear', 'Open settings'],
    ['output', 'Show log']
  ];
  const t = ext.getTranslator('en');
  const quick = `<div class="quickpick"><div class="qp-input">Claude Quota</div>${items
    .map(([ic, label, active]) => `<div class="qp-item ${active ? 'active' : ''}"><i class="codicon codicon-${ic}"></i>${esc(label)}</div>`)
    .join('')}</div>`;
  const { rel, clock } = ext.formatResetParts(quotaWarn.session.resetsAt, NOW, 'en');
  const alert = t('notifyWarning', t('rowSession'), 86, `${rel} (${clock})`);
  const toast = `<div class="toast" style="bottom:36px"><div class="msg"><i class="codicon codicon-warning" style="color:#cca700"></i><div>${esc(alert)}</div></div>
    <div class="src">Source: Claude Quota Status Bar</div>
    <div class="actions"><div class="btn">${esc(t('notifyOpenUsage'))}</div><div class="btn secondary">${esc(t('notifyDisable'))}</div></div></div>`;
  const height = 440;
  images.push({
    name: 'menu-alert.png',
    html: page(windowChrome('Claude Quota — menu & alerts', `<div class="editor">&nbsp;</div>${quick}${toast}`, quotaItem(quotaWarn, sbOpts('en'), 'hover'), height), 900, height + 32),
    width: 900,
    height: height + 32
  });
}

// 4. Auto-resume session picker + resumed notification
{
  const t = ext.getTranslator('en');
  const until = t('autoResumeLimited', ext.formatClock(NOW + 40 * MIN, NOW, 'en'));
  const msg = (m) => t('autoResumeMessageDetail', m);
  const sessions = [
    { name: 'api-refactor', desc: 'shop-api · terminal · idle', detail: `${until} · ${msg('Run the test suite first, then finish the migration')}`, on: true },
    { name: 'docs-site', desc: 'docs · panel · idle', detail: until, on: true },
    { name: 'mobile-app-3f', desc: 'mobile · panel · busy', detail: '', on: false }
  ];
  const quick = `<div class="quickpick"><div class="qp-input">${esc(t('autoResumePickTitle'))}</div>${sessions
    .map((s, i) => `<div class="qp-item ${i === 0 ? 'active' : ''}"><div class="check ${s.on ? 'on' : ''}">${s.on ? '✓' : ''}</div>
      <div><div>${esc(s.name)}<span class="desc">${esc(s.desc)}</span></div>${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''}</div><i class="codicon codicon-edit" style="margin-left:auto;opacity:${i === 0 ? 1 : 0.35}" title="edit"></i></div>`)
    .join('')}<div style="display:flex;justify-content:flex-end;padding:4px"><div class="btn">OK</div></div></div>`;
  const toast1 = `<div class="toast" style="bottom:128px"><div class="msg"><i class="codicon codicon-info" style="color:#3794ff"></i><div>${esc(t('resumedTerminal', 'api-refactor'))}</div></div></div>`;
  const toast2 = `<div class="toast" style="bottom:36px"><div class="msg"><i class="codicon codicon-info" style="color:#3794ff"></i><div>${esc(t('resumedPanel', 'docs-site', 'continue'))}</div></div></div>`;
  const height = 470;
  images.push({
    name: 'auto-resume.png',
    html: page(windowChrome('Claude Quota — auto-resume', `<div class="editor">&nbsp;</div>${quick}${toast1}${toast2}`, quotaItem(quotaNormal, sbOpts('en')), height), 900, height + 32),
    width: 900,
    height: height + 32
  });
}

// 5. Auto-resume mode chooser (configured before stepping away)
{
  const t = ext.getTranslator('en');
  const modes = [
    ['check-all', t('autoResumeModeAll'), t('autoResumeModeAllDetail'), false],
    ['checklist', `${t('autoResumeModeSelected')} ${t('autoResumeCurrent')}`, t('autoResumeModeSelectedDetail'), true],
    ['circle-slash', t('autoResumeModeOffLabel'), '', false]
  ];
  const quick = `<div class="quickpick"><div style="text-align:center;font-size:12px;color:var(--muted);padding:2px 0 6px">${esc(t('autoResumeModeTitle'))}</div>
    <div class="qp-input" style="font-size:12px">${esc(t('autoResumePanelNote'))}</div>${modes
    .map(([ic, label, detail, active]) => `<div class="qp-item ${active ? 'active' : ''}"><i class="codicon codicon-${ic}" style="margin-top:2px"></i>
      <div><div>${esc(label)}</div>${detail ? `<div class="detail">${esc(detail)}</div>` : ''}</div></div>`)
    .join('')}</div>`;
  const height = 340;
  images.push({
    name: 'auto-resume-mode.png',
    html: page(windowChrome('Claude Quota — auto-resume mode', `<div class="editor">&nbsp;</div>${quick}`, quotaItem(quotaNormal, sbOpts('en')), height), 900, height + 32),
    width: 900,
    height: height + 32
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Chrome/Edge not found; set CHROME_PATH');
  return hit;
}

const chrome = findChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-shots-'));
for (const img of images) {
  const htmlPath = path.join(tmp, img.name.replace('.png', '.html'));
  fs.writeFileSync(htmlPath, img.html);
  const out = path.join(OUT_DIR, img.name);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--virtual-time-budget=4000',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--window-size=${img.width},${img.height}`,
    `--screenshot=${out}`,
    'file:///' + htmlPath.replace(/\\/g, '/')
  ], { stdio: 'ignore' });
  console.log('wrote', path.relative(process.cwd(), out));
}
fs.rmSync(tmp, { recursive: true, force: true });
