# Claude Quota Status Bar

Real-time **5-hour session**, **7-day weekly**, and **model-scoped (e.g. Fable)** Claude subscription quota percentages with reset countdowns right on your VS Code / Cursor / Windsurf / Antigravity status bar.

*(Bản hướng dẫn Tiếng Việt ở bên dưới)*

---

## Features

- **Real-time Subscription Percentages**: Displays both rolling **5-hour session** and **7-day weekly** usage percentages (`%`) alongside reset countdowns (`$(pulse) 5h 36% ↻56m · Wk 57% ↻5d` / `$(pulse) 5h 36% ↻56p · Tuần 57% ↻5ng`).
- **Rich Hover Tooltip**: Visual progress bars for **Session (5h)**, **Weekly (7d)**, and **Model-scoped buckets (e.g. Fable)** with exact reset wall-clock times, plus local `.jsonl` token breakdown (`Last 5h` & `Today`).
- **Cross-Platform OAuth Support**:
  - **Windows & Linux / WSL**: Reads existing Claude Code credentials from `~/.claude/.credentials.json` (respects `CLAUDE_CONFIG_DIR`).
  - **macOS**: Reads directly from **macOS Keychain** (`Claude Code-credentials`) with automatic headless dotfile fallback.
- **Multi-Window Rate-Limit Protection**: Shares an atomic local cache (`~/.claude/usage-statusbar-cache.json`) across all open editor windows with fetch locking and `Retry-After` `HTTP 429` backoff, falling back gracefully to local log token counts when offline.
- **Bilingual (`English` & `Tiếng Việt`)**: Auto-detects locale or lets you choose in VS Code Settings, with configurable warning (`80%`) and critical (`95%`) status bar highlight colors.

## Privacy & Security

- **Zero Telemetry, Zero Third-Party Servers**: Your OAuth access token is read strictly in memory on your local machine and sent **only** over HTTPS to `https://api.anthropic.com/api/oauth/usage`.
- **Never Logged or Persisted**: Tokens are never logged to the console, never shown in tooltips or error messages, and never written to the shared quota cache file (which stores numeric percentages and timestamps only with `0600` permissions).
- **Read-Only Credential Handling**: The extension never mutates or rotates your `.credentials.json` or Keychain entry, avoiding refresh-token race conditions with Claude Code CLI.

> **Disclaimer**: This is an independent, unofficial community extension and is **not** affiliated with, endorsed by, or supported by Anthropic. It queries an internal OAuth usage endpoint used by Claude tooling, whose schema or rate limits may change at any time.

## Requirements

- An active **Claude Pro / Max / Team** subscription signed in via **Claude Code** (`claude login`).

## Extension Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| `claudeQuota.language` | `"auto"` | Display language: `"auto"`, `"vi"` (Tiếng Việt), or `"en"` (English). |
| `claudeQuota.showScopedOnStatusBar` | `false` | Show model-scoped weekly quota (e.g. `Fable 10%`) directly on the status bar. |
| `claudeQuota.warningThreshold` | `80` | Percentage threshold for warning background highlight. |
| `claudeQuota.errorThreshold` | `95` | Percentage threshold for error background highlight. |
| `claudeQuota.refreshIntervalSeconds` | `60` | Shared API refresh interval in seconds across windows (`30`–`600`). |
| `claudeQuota.alignment` | `"right"` | Status bar alignment (`"right"` or `"left"`). |

---

## Tiếng Việt — Hạn mức Claude trên Thanh trạng thái

Tiện ích mã nguồn mở giúp hiển thị **đồng thời, thời gian thực** phần trăm hạn mức **Phiên 5 giờ**, **Tuần 7 ngày** và **Mô hình phụ (như Fable)** kèm thời gian đếm ngược đặt lại ngay ở góc phải dưới thanh trạng thái của **VS Code / Antigravity / Cursor / Windsurf**.

### Điểm nổi bật
- **Hiển thị trực quan**: `$(pulse) 5h 36% ↻56p · Tuần 57% ↻5ng`, tự động đổi màu nền cảnh báo khi chạm **80%** và **95%**.
- **Bảng chú giải đầy đủ**: Hiển thị thanh tiến độ cho cả **Phiên (5 giờ)**, **Tuần (7 ngày)**, **Tuần (Fable)** cùng giờ đặt lại chính xác và thống kê nhật ký máy cục bộ.
- **Đa hệ điều hành**: Tự động đọc phiên đăng nhập Claude Code sẵn có trên **Windows**, **Linux/WSL** (`~/.claude/.credentials.json`) và **macOS Keychain** (`Claude Code-credentials`).
- **Chống giới hạn lượt gọi (`HTTP 429`)**: Đồng bộ bộ đệm giữa mọi cửa sổ VS Code đang mở, không gây nghẽn mạng.
- **An toàn tuyệt đối**: Khóa xác thực chỉ đọc trong bộ nhớ và gửi trực tiếp tới `api.anthropic.com`, không qua bất kỳ máy chủ trung gian nào, không ghi ra nhật ký hay tệp bộ đệm.

### Cài đặt thủ công từ tệp `.vsix`
1. Tải tệp `claude-quota-statusbar-1.0.0.vsix` trong mục **Releases** trên GitHub.
2. Mở VS Code ➔ nhấn `Ctrl+Shift+P` (`Cmd+Shift+P` trên macOS) ➔ chọn **Extensions: Install from VSIX...** ➔ chọn tệp vừa tải.

## License

[MIT](./LICENSE) © Tran Hiep (Franky755)

