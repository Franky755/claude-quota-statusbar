const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let mockConfig = {
  language: 'vi',
  showScopedOnStatusBar: false,
  warningThreshold: 80,
  errorThreshold: 95,
  refreshIntervalSeconds: 60,
  alignment: 'right'
};

const createdItems = [];

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
        dispose() {}
      };
      createdItems.push(item);
      return item;
    }
  },
  commands: {
    registerCommand() {
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
  resolveLanguage,
  parseQuotaPayload,
  formatResetShort,
  formatStatusBarText,
  buildTooltipMarkdown,
  pickSeverityLevel,
  readOauthAccessToken,
  fetchOrLoadQuota
} = ext._internal;

async function main() {
  console.log('1. Testing language detection & bilingual formatting (vi / en)...');
  assert.strictEqual(resolveLanguage('vi', 'en'), 'vi');
  assert.strictEqual(resolveLanguage('en', 'vi'), 'en');
  assert.strictEqual(resolveLanguage('auto', 'vi-VN'), 'vi');

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

  const dummyLocal = {
    win: { input: 100000, output: 50000, cacheWrite: 6350000, cacheRead: 40000000 },
    today: { input: 400000, output: 300000, cacheWrite: 25200000, cacheRead: 180000000 }
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

  console.log('3. Testing shared disk cache, 429 backoff & zero token leakage...');
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

  const second = await fetchOrLoadQuota({ credPath: fakeCred, cachePath: fakeCache, requestImpl: mockRequest });
  assert.strictEqual(calls, 1);
  assert.strictEqual(second.quota.weekly.percent, 57);

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

  const cacheContent = fs.readFileSync(fakeCache, 'utf8');
  const viTooltip = buildTooltipMarkdown(third, dummyLocal, futureMs, 'vi');
  const enTooltip = buildTooltipMarkdown(third, dummyLocal, futureMs, 'en');
  assert.ok(!cacheContent.includes(WIN_SECRET), 'Cache file must never contain token');
  assert.ok(!viTooltip.includes(WIN_SECRET), 'VI tooltip must never contain token');
  assert.ok(!enTooltip.includes(WIN_SECRET), 'EN tooltip must never contain token');
  assert.ok(viTooltip.includes('lưu đệm'));
  assert.ok(enTooltip.includes('cached quota'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('All unit, cross-platform, and security tests passed!');
}

main().catch((err) => {
  console.error('Test failed:', err && err.message);
  process.exit(1);
});

