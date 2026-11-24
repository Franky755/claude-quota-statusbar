# Changelog

## [1.0.0] - 2026-11-24

### Added
- Real-time 5-hour session, 7-day weekly, and model-scoped (e.g. Fable) quota percentages and reset countdowns on the status bar.
- Rich hover tooltip with visual progress bars, exact reset timestamps, and local `.jsonl` token usage stats.
- Cross-platform Claude Code OAuth lookup supporting Windows/Linux (`~/.claude/.credentials.json`, `CLAUDE_CONFIG_DIR`) and macOS Keychain (`Claude Code-credentials`).
- Cross-window atomic quota cache with fetch lock and `HTTP 429` `Retry-After` backoff.
- Bilingual support (`Tiếng Việt` and `English`) and customizable thresholds/alignment in VS Code Settings.

