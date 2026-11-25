const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Keep the activation smoke test away from the real ~/.claude directory
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-oss-sandbox-'));
process.env.CLAUDE_CONFIG_DIR = sandboxDir;

let mockConfig = {
  language: 'vi',
  showScopedOnStatusBar: false,
  warningThreshold: 80,
  errorThreshold: 95,
  refreshIntervalSeconds: 60,
  alignment: 'right'
};

const createdItems = [];
const registeredCommands = {};

const vscodeMock = {
  env: { language: 'en' },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  },
  workspace: {
    getConfiguration() {
      return {
        get(key, def) {
          return Object.prototype.hasOwnProperty.call(mockConfig, key) ? mockConfig[key] : def;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  },
  window: {
    createStatusBarItem(alignment, priority) {
      const item = {
        alignment,
        priority,
        text: '',
        tooltip: null,
        backgroundColor: undefined,
        command: undefined,
        shown: false,
        show() {
          this.shown = true;
        },
        hide() {
          this.shown = false;
        },
        dispose() {}
      };
      createdItems.push(item);
      return item;
    }
  },
  commands: {
    registerCommand(id, fn) {
      registeredCommands[id] = fn;
      return { dispose() {} };
    }
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const ext = require('../extension.js');
const {
  SUPPORTED_LANGS,
  getTranslator,
  resolveLanguage,
  parseQuotaPayload,
  formatResetShort,
  formatResetLong,
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
} = ext._internal;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function jsonlLine({ id, ts, model = 'claude-opus-5-5', input = 0, output = 0, cw = 0, cw1h = 0, cr = 0 }) {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cw,
        cache_creation: { ephemeral_5m_input_tokens: cw - cw1h, ephemeral_1h_input_tokens: cw1h },
        cache_read_input_tokens: cr
      }
    }
  }) + '\n';
}

async function main() {
  console.log('1. Testing language detection & formatting (all locales)...');
  assert.strictEqual(resolveLanguage('vi', 'en', ''), 'vi');
  assert.strictEqual(resolveLanguage('en', 'vi', ''), 'en');
  assert.strictEqual(resolveLanguage('auto', 'vi-VN', ''), 'vi');
  assert.strictEqual(resolveLanguage('auto', 'ja', ''), 'ja');
  assert.strictEqual(resolveLanguage('auto', 'zh-tw', ''), 'zh-cn');
  assert.strictEqual(resolveLanguage('auto', 'pt-PT', ''), 'pt-br');
  assert.strictEqual(resolveLanguage('auto', 'en', 'de-DE'), 'de', 'non-English OS locale wins over default English UI');
  assert.strictEqual(resolveLanguage('auto', 'it', 'it-IT'), 'en', 'unsupported locale falls back to English');
  assert.strictEqual(resolveLanguage('xx', 'en', ''), 'en');

  // Every locale file must define every English key and the same {n} placeholders
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', 'en.json'), 'utf8'));
  const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
  for (const lang of SUPPORTED_LANGS) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', `${lang}.json`), 'utf8'));
    for (const key of Object.keys(en)) {
      assert.ok(typeof data[key] === 'string', `${lang}.json missing "${key}"`);
      assert.strictEqual(placeholders(data[key]), placeholders(en[key]), `${lang}.json placeholder mismatch in "${key}"`);
    }
  }
  assert.strictEqual(getTranslator('xx')('itemName'), 'Claude Quota', 'unknown language falls back to English');
  assert.strictEqual(getTranslator('vi')('note.serverBusy', 503), 'Máy chủ hạn mức tạm bận (503)');

  const nowMs = Date.parse('2026-11-24T14:50:08.000Z');
  const sampleApi = {
    five_hour: { utilization: 36, resets_at: '2026-11-24T15:49:59.636018+00:00' },
    seven_day: { utilization: 57, resets_at: '2026-11-30T06:59:59.636035+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 36, severity: 'normal', resets_at: '2026-11-24T15:49:59.636018+00:00' },
      { kind: 'weekly_all', group: 'weekly', percent: 57, severity: 'normal', resets_at: '2026-11-30T06:59:59.636035+00:00' },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 10,
        severity: 'normal',
        resets_at: '2026-11-30T06:59:59.636158+00:00',
        scope: { model: { display_name: 'Fable' } }
      }
    ]
  };

  const quota = parseQuotaPayload(sampleApi);
  assert.strictEqual(formatResetShort(quota.session.resetsAt, nowMs, 'vi'), '1h');
  assert.strictEqual(formatResetShort(quota.weekly.resetsAt, nowMs, 'vi'), '5ng');
  assert.strictEqual(formatResetShort(quota.weekly.resetsAt, nowMs, 'en'), '5d');
  assert.strictEqual(formatResetShort(quota.weekly.resetsAt, nowMs, 'ja'), '5日');
  assert.ok(formatResetLong(quota.weekly.resetsAt, nowMs, 'en').startsWith('in 5d 16h *('));
  assert.ok(formatResetLong(quota.weekly.resetsAt, nowMs, 'vi').startsWith('sau 5 ngày 16 giờ *('));

  const dummyLocal = {
    win: { input: 100000, output: 50000, cacheWrite: 6350000, cacheWrite1h: 0, cacheRead: 40000000 },
    today: { input: 400000, output: 300000, cacheWrite: 25200000, cacheWrite1h: 0, cacheRead: 180000000 },
    byModel: []
  };

  assert.strictEqual(
    formatStatusBarText(quota, dummyLocal, nowMs, { lang: 'vi', showScopedOnStatusBar: false }),
    '$(pulse) 5h 36% ↻1h · Tuần 57% ↻5ng'
  );
  assert.strictEqual(
    formatStatusBarText(quota, dummyLocal, nowMs, { lang: 'vi', showScopedOnStatusBar: true }),
    '$(pulse) 5h 36% ↻1h · Tuần 57% ↻5ng · Fable 10%'
  );
  assert.strictEqual(
    formatStatusBarText(quota, dummyLocal, nowMs, { lang: 'en', showScopedOnStatusBar: false }),
    '$(pulse) 5h 36% ↻1h · Wk 57% ↻5d'
  );
  assert.strictEqual(
    formatStatusBarText(quota, dummyLocal, nowMs, { lang: 'en', format: '{icon} {max}% · {scoped} {unknown}' }),
    '$(pulse) 57% · Fable 10% {unknown}',
    'custom template substitutes known placeholders only'
  );
  assert.strictEqual(
    formatStatusBarText(null, dummyLocal, nowMs, { lang: 'en' }),
    '$(pulse) 5h: 6.5M · Today: 25.9M'
  );

  assert.strictEqual(pickSeverityLevel(quota, 80, 95), 'normal');
  assert.strictEqual(pickSeverityLevel(quota, 55, 95), 'warning');
  assert.strictEqual(pickSeverityLevel(quota, 40, 55), 'error');

  console.log('2. Testing cross-platform credential lookup (dotfile + macOS Keychain)...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-oss-test-'));
  const missingCred = path.join(tmpDir, 'missing.json');
  const MAC_SECRET = 'sk-ant-oat01-MAC_KEYCHAIN_SECRET_DO_NOT_LEAK';

  const macRes = readOauthAccessToken({
    credPath: missingCred,
    nowMs,
    platform: 'darwin',
    execKeychain(bin, args) {
      assert.strictEqual(bin, '/usr/bin/security');
      assert.ok(args.includes('Claude Code-credentials'));
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: MAC_SECRET,
          expiresAt: nowMs + 3600_000
        }
      });
    }
  });
  assert.strictEqual(macRes.token, MAC_SECRET);
  assert.strictEqual(macRes.noticeKey, null);

  console.log('3. Testing shared disk cache, 429 backoff, history & zero token leakage...');
  const fakeCred = path.join(tmpDir, 'cred.json');
  const fakeCache = path.join(tmpDir, 'cache.json');
  const WIN_SECRET = 'sk-ant-oat01-WIN_SECRET_TOKEN_DO_NOT_LEAK';

  fs.writeFileSync(
    fakeCred,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: WIN_SECRET,
        expiresAt: Date.now() + 3600_000
      }
    })
  );

  let calls = 0;
  let statusToReturn = 200;
  const mockRequest = (url, opts, cb) => {
    calls++;
    assert.strictEqual(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.strictEqual(opts.headers.Authorization, `Bearer ${WIN_SECRET}`);
    assert.ok(!('Content-Type' in opts.headers), 'GET request must not send a Content-Type');
    return {
      on() {},
      destroy() {},
      end() {
        const listeners = {};
        cb({
          statusCode: statusToReturn,
          headers: statusToReturn === 429 ? { 'retry-after': '120' } : {},
          setEncoding() {},
          on(ev, fn) {
            listeners[ev] = fn;
          }
        });
        listeners.data(
          statusToReturn === 200
            ? JSON.stringify(sampleApi)
            : JSON.stringify({ detail: WIN_SECRET })
        );
        listeners.end();
      }
    };
  };

  const first = await fetchOrLoadQuota({ credPath: fakeCred, cachePath: fakeCache, requestImpl: mockRequest });
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.quota.session.percent, 36);
  assert.strictEqual(first.fresh, true);
  assert.strictEqual(first.history.length, 1, 'successful fetch records a history sample');

  const second = await fetchOrLoadQuota({ credPath: fakeCred, cachePath: fakeCache, requestImpl: mockRequest });
  assert.strictEqual(calls, 1);
  assert.strictEqual(second.quota.weekly.percent, 57);
  assert.strictEqual(second.fresh, false);
  assert.strictEqual(second.history.length, 1, 'history survives cache reads');

  statusToReturn = 429;
  const futureMs = Date.now() + 70_000;
  const third = await fetchOrLoadQuota({
    nowMs: futureMs,
    credPath: fakeCred,
    cachePath: fakeCache,
    requestImpl: mockRequest
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(third.quota.session.percent, 36);
  assert.strictEqual(third.noticeKey, 'rateLimited');
  assert.strictEqual(third.history.length, 1, 'failed fetch keeps history');

  const cacheContent = fs.readFileSync(fakeCache, 'utf8');
  const viTooltip = buildTooltipMarkdown(third, dummyLocal, futureMs, 'vi');
  const enTooltip = buildTooltipMarkdown(third, dummyLocal, futureMs, 'en');
  assert.ok(!cacheContent.includes(WIN_SECRET), 'Cache file must never contain token');
  assert.ok(!viTooltip.includes(WIN_SECRET), 'VI tooltip must never contain token');
  assert.ok(!enTooltip.includes(WIN_SECRET), 'EN tooltip must never contain token');
  assert.ok(viTooltip.includes('lưu đệm'));
  assert.ok(enTooltip.includes('cached quota'));
  for (const lang of SUPPORTED_LANGS) {
    const md = buildTooltipMarkdown(third, dummyLocal, futureMs, lang);
    assert.ok(!/\b(row|note|tok|local)[A-Z.]\w*/.test(md), `${lang} tooltip shows a raw i18n key`);
  }

  console.log('4. Testing reset fast-retry is capped to one attempt per reset...');
  const pastReset = { session: { percent: 99, resetsAt: new Date(nowMs - MIN).toISOString() }, weekly: null };
  assert.strictEqual(hasPassedReset(pastReset, nowMs, nowMs - 10 * MIN), true, 'not refetched since reset');
  assert.strictEqual(hasPassedReset(pastReset, nowMs, nowMs - 30 * 1000), false, 'already refetched after reset');

  const resetCache = path.join(tmpDir, 'reset-cache.json');
  const realNow = Date.now();
  fs.writeFileSync(resetCache, JSON.stringify({
    fetchedAt: realNow - 20 * 1000,
    quota: { session: { percent: 99, resetsAt: new Date(realNow - MIN).toISOString() }, weekly: null, scoped: [] }
  }));
  statusToReturn = 200;
  const callsBefore = calls;
  await fetchOrLoadQuota({ credPath: fakeCred, cachePath: resetCache, requestImpl: mockRequest });
  assert.strictEqual(calls, callsBefore, 'stale resets_at after a post-reset fetch must not trigger fast retries');

  console.log('5. Testing incremental async .jsonl parsing, per-model totals & cost...');
  const projects = path.join(tmpDir, 'projects', 'demo');
  fs.mkdirSync(projects, { recursive: true });
  const logFile = path.join(projects, 'session.jsonl');
  const tsNow = Date.now();
  fs.writeFileSync(
    logFile,
    jsonlLine({ id: 1, ts: tsNow - MIN, input: 1000, output: 2000, cw: 3000, cw1h: 1000, cr: 4000 }) +
      jsonlLine({ id: 2, ts: tsNow - MIN, model: 'claude-haiku-5-5', input: 500, output: 500 }) +
      jsonlLine({ id: 2, ts: tsNow - MIN, model: 'claude-haiku-5-5', input: 500, output: 500 }) +
      '{"broken json\n'
  );
  let local = await collectLocalTokens(tsNow, path.join(tmpDir, 'projects'));
  assert.strictEqual(local.win.input, 1500, 'duplicate message ids are counted once');
  assert.strictEqual(local.byModel.length, 2);

  // Append a complete line plus a half-written one; only the complete line counts
  const partial = jsonlLine({ id: 4, ts: tsNow, input: 7 });
  fs.appendFileSync(logFile, jsonlLine({ id: 3, ts: tsNow, input: 100 }) + partial.slice(0, 20));
  local = await collectLocalTokens(tsNow, path.join(tmpDir, 'projects'));
  assert.strictEqual(local.win.input, 1600);
  fs.appendFileSync(logFile, partial.slice(20));
  local = await collectLocalTokens(tsNow, path.join(tmpDir, 'projects'));
  assert.strictEqual(local.win.input, 1607, 'half-written line is picked up once completed');

  const opus = local.byModel.find((m) => m.model === 'claude-opus-5-5');
  assert.strictEqual(opus.cacheWrite1h, 1000);
  assert.deepStrictEqual(findModelPricing('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
  assert.strictEqual(findModelPricing('claude-opus-5').input, 5, 'opus-5-5 must not shadow opus-5');
  assert.strictEqual(findModelPricing('claude-sonnet-4-6').input, 3);
  assert.strictEqual(findModelPricing('mystery-model'), null);
  const cost = estimateCostUsd({ input: 1e6, output: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6, cacheRead: 1e6 }, 'claude-opus-5-5');
  // 4 + 20 + 1M*4*1.25 + 1M*4*2 + 0.2
  assert.ok(Math.abs(cost - (4 + 20 + 5 + 8 + 0.2)) < 1e-9);

  const costTooltip = buildTooltipMarkdown({ quota }, local, nowMs, 'en');
  assert.ok(costTooltip.includes('`opus-5-5`'));
  assert.ok(costTooltip.includes('Total'));
  assert.ok(!buildTooltipMarkdown({ quota }, local, nowMs, 'en', { showCost: false }).includes('opus-5-5'));

  console.log('6. Testing burn-rate forecast...');
  const resetIso = new Date(nowMs + 2 * HOUR).toISOString();
  let history = [];
  history = appendHistory(history, { session: { percent: 20, resetsAt: resetIso }, weekly: null }, nowMs - 60 * MIN);
  history = appendHistory(history, { session: { percent: 20, resetsAt: resetIso }, weekly: null }, nowMs - 58 * MIN);
  assert.strictEqual(history.length, 1, 'unchanged samples within the gap are skipped');
  history = appendHistory(history, { session: { percent: 50, resetsAt: resetIso }, weekly: null }, nowMs - 30 * MIN);
  const hit = computeForecast(history, 'session', { percent: 80, resetsAt: resetIso }, nowMs);
  assert.strictEqual(hit.type, 'hit');
  assert.ok(Math.abs(hit.atMs - (nowMs + 20 * MIN)) < 1000, '60%/h pace hits 100% in 20 minutes');
  const slow = computeForecast(history, 'session', { percent: 22, resetsAt: resetIso }, nowMs);
  assert.deepStrictEqual(slow, { type: 'ok', percent: 26 });
  assert.strictEqual(
    computeForecast(history, 'session', { percent: 80, resetsAt: new Date(nowMs + 4 * HOUR).toISOString() }, nowMs),
    null,
    'samples from a different reset window are ignored'
  );
  const forecastTooltip = buildTooltipMarkdown(
    { quota: { session: { percent: 80, resetsAt: resetIso }, weekly: null, scoped: [] }, history },
    dummyLocal,
    nowMs,
    'en'
  );
  assert.ok(forecastTooltip.includes('At this pace: 100% around'));

  console.log('7. Testing threshold notification planning...');
  const alertQuota = {
    session: { percent: 85, resetsAt: resetIso },
    weekly: { percent: 96, resetsAt: '2026-11-30T06:59:59Z' },
    scoped: [{ name: 'Fable', percent: 10, resetsAt: '2026-11-30T06:59:59Z' }]
  };
  let plan = planNotifications(alertQuota, {}, 80, 95, nowMs);
  assert.deepStrictEqual(plan.due.map((d) => `${d.id}:${d.level}`), ['weekly:error', 'session:warning']);
  plan = planNotifications(alertQuota, plan.notified, 80, 95, nowMs + MIN);
  assert.strictEqual(plan.due.length, 0, 'same level is announced only once per reset window');
  alertQuota.session.percent = 97;
  plan = planNotifications(alertQuota, plan.notified, 80, 95, nowMs + 2 * MIN);
  assert.deepStrictEqual(plan.due.map((d) => `${d.id}:${d.level}`), ['session:error'], 'escalation is announced');
  const afterReset = planNotifications(alertQuota, plan.notified, 80, 95, nowMs + 3 * HOUR);
  assert.ok(!Object.keys(afterReset.notified).some((k) => k.startsWith('session|') && k.endsWith(resetIso) && afterReset.due.length === 0));

  console.log('8. Testing hide-when-signed-out & plain-text summary...');
  assert.strictEqual(shouldHideItem({ quota: null, noticeKey: 'noCredFile' }, { hideWhenSignedOut: true }), true);
  assert.strictEqual(shouldHideItem({ quota: null, noticeKey: 'noCredFile' }, { hideWhenSignedOut: false }), false);
  assert.strictEqual(shouldHideItem({ quota: null, noticeKey: 'timeout' }, { hideWhenSignedOut: true }), false);
  assert.strictEqual(shouldHideItem({ quota, noticeKey: 'noCredFile' }, { hideWhenSignedOut: true }), false);
  const plain = markdownToPlain(enTooltip);
  assert.ok(!/[*`]/.test(plain) && plain.includes('Session (5h): █'));

  console.log('9. Testing auto-resume of limited sessions...');
  const ar = require('../autoResume.js');
  const limitRecord = (resetsAtSec, extra = {}) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(nowMs - HOUR).toISOString(),
    isApiErrorMessage: true,
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' } },
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm" }] },
    ...extra
  });
  const resetSec = Math.floor((nowMs - 5 * MIN) / 1000);
  const userLine = JSON.stringify({ type: 'user', message: { content: 'hi' } });
  const queueLine = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' });

  let state = ar.parseLimitState([userLine, limitRecord(resetSec), queueLine, ''].join('\n'));
  assert.deepStrictEqual(
    { limited: state.limited, resetsAtMs: state.resetsAtMs, limitType: state.limitType },
    { limited: true, resetsAtMs: resetSec * 1000, limitType: 'five_hour' },
    'trailing bookkeeping records do not hide the limit error'
  );
  assert.strictEqual(ar.parseLimitState([limitRecord(resetSec), userLine].join('\n')).limited, false, 'user already continued');
  assert.strictEqual(
    ar.parseLimitState([limitRecord(resetSec), JSON.stringify({ type: 'user', isSidechain: true })].join('\n')).limited,
    true,
    'sidechain (subagent) records are ignored'
  );
  assert.strictEqual(ar.parseLimitState('').limited, false);

  const limitedSession = (id, extra = {}) => ({
    sessionId: id,
    status: 'idle',
    limit: { limited: true, resetsAtMs: resetSec * 1000, limitType: 'five_hour' },
    ...extra
  });
  const base = {
    sessions: [limitedSession('a'), limitedSession('b'), limitedSession('c', { status: 'busy' })],
    selected: ['a', 'c'],
    resumed: {},
    quota: { session: { percent: 3 }, weekly: { percent: 40 } },
    nowMs,
    delayMs: 60 * 1000
  };
  const ids = (list) => list.map((s) => s.sessionId);
  assert.deepStrictEqual(ids(ar.planAutoResume({ ...base, mode: 'off' })), []);
  assert.deepStrictEqual(ids(ar.planAutoResume({ ...base, mode: 'selected' })), ['a'], 'only picked, idle sessions');
  assert.deepStrictEqual(ids(ar.planAutoResume({ ...base, mode: 'all' })), ['a', 'b']);
  assert.deepStrictEqual(ids(ar.planAutoResume({ ...base, mode: 'all', delayMs: 10 * MIN })), [], 'waits for the delay');
  assert.deepStrictEqual(
    ids(ar.planAutoResume({ ...base, mode: 'all', resumed: { [`a|${resetSec * 1000}`]: nowMs } })),
    ['b'],
    'a limit is resumed only once'
  );
  assert.deepStrictEqual(
    ids(ar.planAutoResume({ ...base, mode: 'all', quota: { session: { percent: 100 } } })),
    [],
    'does not resume while the live quota is still exhausted'
  );

  assert.ok(ar.isInsideFolders('D:\\Code\\App\\src', ['d:\\code\\app'], 'win32'));
  assert.ok(!ar.isInsideFolders('d:\\code\\app2', ['d:\\code\\app'], 'win32'), 'sibling folder with shared prefix');

  const parents = { 300: 200, 200: 100, 100: 1 };
  const term = { name: 'zsh', processId: Promise.resolve(100) };
  const found = await ar.findTerminalForPid(300, [{ processId: Promise.resolve(999) }, term], async (p) => parents[p] || null);
  assert.strictEqual(found, term, 'walks up from claude to the shell of its terminal');
  assert.strictEqual(await ar.findTerminalForPid(300, [], async () => null), null);

  const regDir = path.join(tmpDir, 'claude-home', 'sessions');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, '11.json'), JSON.stringify({ pid: 11, sessionId: 's-live', cwd: '/w', status: 'idle', entrypoint: 'cli' }));
  fs.writeFileSync(path.join(regDir, '22.json'), JSON.stringify({ pid: 22, sessionId: 's-dead', cwd: '/w', status: 'idle' }));
  fs.writeFileSync(path.join(regDir, '11.secret.key'), 'not json');
  const running = await ar.listRunningSessions(path.join(tmpDir, 'claude-home'), (pid) => pid === 11);
  assert.deepStrictEqual(running.map((s) => s.sessionId), ['s-live'], 'only sessions with a live PID count as open');
  const projDir = path.join(tmpDir, 'claude-home', 'projects', 'any-encoding');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 's-live.jsonl'), userLine + '\n' + limitRecord(resetSec) + '\n');
  const transcript = await ar.findTranscript(path.join(tmpDir, 'claude-home'), 's-live');
  assert.strictEqual(ar.parseLimitState(await ar.readTail(transcript)).limited, true);

  assert.strictEqual(ar.resolveResumeMessage('a', { a: '  run the tests, then continue ' }, 'continue'), 'run the tests, then continue');
  assert.strictEqual(ar.resolveResumeMessage('b', { a: 'x' }, 'continue'), 'continue', 'other sessions use the default');
  assert.strictEqual(ar.resolveResumeMessage('a', { a: '   ' }, ''), 'continue', 'blank falls back to continue');
  assert.strictEqual(ar.toSingleLine('Step 1: fix build\r\n  Step 2: run tests\n'), 'Step 1: fix build Step 2: run tests');

  const arTooltip = buildTooltipMarkdown({ quota }, dummyLocal, nowMs, 'en', {
    autoResumeMode: 'selected',
    autoResumeSessions: [{ name: 'api-fix', willResume: true, customMessage: true, message: 'run `npm test` then continue', limit: { limited: true, resetsAtMs: nowMs + HOUR } }]
  });
  assert.ok(arTooltip.includes('**Auto-resume**: on for 1 picked session(s)') && arTooltip.includes('api-fix: limited — resumes around'));
  assert.ok(buildTooltipMarkdown({ quota }, dummyLocal, nowMs, 'en', { autoResumeMode: 'all' }).includes('**Auto-resume**: on for all open sessions'), 'armed status shows even before any limit');
  assert.ok(!buildTooltipMarkdown({ quota }, dummyLocal, nowMs, 'en', { autoResumeMode: 'off' }).includes('Auto-resume'));
  assert.ok(arTooltip.includes("→ `run 'npm test' then continue`"), 'tooltip shows the per-session message without breaking markdown');

  console.log('10. Testing activation smoke test (sandboxed, offline)...');
  mockConfig = { ...mockConfig, language: 'en', hideWhenSignedOut: true };
  const subscriptions = [];
  ext.activate({ subscriptions });
  for (let i = 0; i < 50 && createdItems[0].shown; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(createdItems[0].command, 'claudeQuota.showMenu');
  assert.strictEqual(createdItems[0].shown, false, 'item hidden when no credentials and hideWhenSignedOut is on');
  for (const id of ['claudeQuota.refresh', 'claudeQuota.showMenu', 'claudeQuota.showLog', 'claudeQuota.manageAutoResume']) {
    assert.strictEqual(typeof registeredCommands[id], 'function', `${id} registered`);
  }
  for (const s of subscriptions) s.dispose();

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(sandboxDir, { recursive: true, force: true });
  console.log('All unit, cross-platform, and security tests passed!');
}

main().catch((err) => {
  console.error('Test failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
