# Changelog

## 0.2.1 — 2026-10-23

- Default to loopback with public tunnels disabled; remove the author's domain from defaults and examples. Generate a long local credential, require 24+ characters for public mode, and avoid printing credentials or passing tunnel tokens in argv.
- Advertise public QR codes only after tunnel registration; handle early exit, timeout and later tunnel exit. Preserve DNS records unless overwrite is explicitly enabled.
- Ignore direct-client forwarded IP headers, validate the local QR bypass and WebSocket origins, bound frames/input, and serve browser assets locally.
- Protect replacement PTYs from stale exit/data callbacks. Retain unsent prompts, acknowledge writes, deduplicate recent prompt IDs and replace history on reconnect.
- Repair missing macOS spawn-helper execute bits in node-pty 1.1.0 before starting a terminal; verify an actual PTY command on all CI platforms.
- Parse NUL-delimited Git status, show new-directory/Unicode paths, resolve repository roots and report omitted previews instead of a false clean state.
- Add English/Chinese setup, migration, configuration and security documentation, regression tests and a Windows/macOS/Linux CI matrix on Node 22/24.

中文：默认仅本机访问，移除作者域名；加强凭据、鉴权、隧道及终端生命周期；修复中文/新目录 Diff、断线丢输入与重连重复显示；补充中英文使用说明和跨平台自动化测试。真实手机、Codex 交互与公网连接仍需独立验证。
