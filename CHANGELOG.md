# Changelog

## [1.1.0] - 2026-11-25

### Added
- Auto-resume for open Claude Code sessions that stopped on a usage limit: terminal (CLI) sessions are resumed automatically, Claude Code panel sessions open with the message pre-filled. It is set up in advance from the menu: all open sessions (including later ones), only picked sessions, or off. The tooltip always shows whether it is armed. Resumed sessions get `continue` by default; an optional per-session message (✎ in the picker) can queue the next step.
- Threshold notifications, once per reset window, when a quota crosses the warning or error threshold.
- Burn-rate forecast in the tooltip (when you will hit 100%, or where you will land at reset).
- Today's local token usage per model with an estimated API-equivalent cost, including 1-hour cache writes.
- Quick menu on click (refresh, Claude usage page, auto-resume, copy summary, settings, log) and `claudeQuota.clickAction` to keep one-click refresh.
- Custom status bar template (`claudeQuota.statusBarFormat`) and `claudeQuota.hideWhenSignedOut`.
- 8 more languages: 简体中文, 日本語, 한국어, Español, Português (Brasil), Français, Deutsch, Русский. Reset times now follow the locale's time format.
- **Claude Quota** output channel for diagnostics (HTTP status codes and backoff, never tokens).
- README feature images generated from the extension's own formatting code (`npm run screenshots`).

### Changed
- Runtime strings moved to `i18n/<lang>.json`; the fallback language is now English instead of Vietnamese.
- Local `.jsonl` logs are read asynchronously and incrementally (only bytes appended since the last scan).

### Fixed
- Clicking the status bar during a background refresh was silently ignored; the refresh is now queued and shows a spinner.
- After a reset, a stale `resets_at` from the API could trigger a fast retry every tick; the fast retry now happens at most once per reset.
- Removed the unnecessary `Content-Type` header from the usage `GET` request.

## [1.0.0] - 2026-11-24

### Added
- Real-time 5-hour session, 7-day weekly, and model-scoped (e.g. Fable) quota percentages and reset countdowns on the status bar.
- Rich hover tooltip with visual progress bars, exact reset timestamps, and local `.jsonl` token usage stats.
- Cross-platform Claude Code OAuth lookup supporting Windows/Linux (`~/.claude/.credentials.json`, `CLAUDE_CONFIG_DIR`) and macOS Keychain (`Claude Code-credentials`).
- Cross-window atomic quota cache with fetch lock and `HTTP 429` `Retry-After` backoff.
- Bilingual support (`Tiếng Việt` and `English`) and customizable thresholds/alignment in VS Code Settings.
