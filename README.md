# 🚀 codex-relay

> **专为手机端远程控制本地 OpenAI Codex CLI、支持双端查看代码 Diff 并一键审批的轻量级开源桥接器。**  
> A lightweight mobile-first web bridge for remote-controlling local OpenAI Codex CLI with real-time `xterm.js` streaming, `diff2html` Git Diff preview, and thumb-friendly one-tap approval.

---

## ✨ 核心特性 (Features)

- **🖥️ 实时终端双向流 (`node-pty` + `ws` + `xterm.js`)**：在本地托管 OpenAI `codex` CLI 终端会话，手机与电脑浏览器实时同步终端画面与输入。
- **👍 专为单手握持设计的大号拇指审批区**：下半屏配备超大尺寸 **`[Approve (y)]`** 与 **`[Reject (n)]`** 按钮（支持手机震动触觉反馈），躺在沙发上也能一键审批 Codex 的代码修改请求。
- **🔀 红绿色块代码 Diff 预览 (`diff2html`)**：内置 `[Git Diff]` 标签页，实时读取本地 `git status` 与 `git diff`（包含新增未跟踪文件预览），以清晰的红绿高亮色块展示每一行代码变更，支持按文件筛选。
- **🔌 断线重连与输出缓存**：内置 64KB 终端环形缓冲区，手机锁屏或切后台重新打开网页时自动恢复上下文。

---

## 🏗️ 技术栈 (Tech Stack)

- **Runtime & Language**: Node.js + TypeScript
- **HTTP & WebSocket Server**: Express + `ws`
- **Pseudo-Terminal (PTY)**: `node-pty`
- **Frontend Terminal & Diff UI**: `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`) + `diff2html`

---

## 🚀 快速开始 (Quick Start)

### 1. 克隆并安装依赖

```bash
git clone https://github.com/lmjxff/codex-relay.git
cd codex-relay
npm install
```

> **Windows 环境提示**：`node-pty` 在大多数 Node.js 版本下会自动使用预编译二进制包；若触发源码编译，请确保已安装 Visual Studio C++ Build Tools。

### 2. 启动开发服务

```bash
npm run dev
```

或者编译后运行生产版本：

```bash
npm run build
npm run serve
```

### 3. 在电脑或手机端访问

启动后终端会打印本机与局域网访问地址：

```text
====================================================
  🚀 Codex Relay — Mobile Codex CLI Bridge
  📂 Workspace : E:\your-project
  🤖 Command   : codex
  💻 Local URL : http://localhost:3210
  📱 Mobile URL: http://192.168.x.x:3210
====================================================
```

确保手机与电脑处于同一局域网（Wi-Fi）或通过 Tailscale 组网，在手机浏览器打开 `Mobile URL` 即可使用。

---

## ⚙️ 环境变量配置 (Environment Variables)

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3210` | HTTP / WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 绑定网卡地址（默认允许局域网手机访问） |
| `CODEX_CWD` | 当前工作目录 | 要让 Codex 操作的目标 Git 仓库路径 |
| `CODEX_CMD` | `codex` | 启动后自动执行的 CLI 命令 |
| `AUTO_START_CODEX` | `true` | 启动 PTY 后是否自动输入并执行 `CODEX_CMD` |

示例（指定目标项目目录启动）：

```bash
# PowerShell
$env:CODEX_CWD="E:\my-target-repo"; npm run dev

# Bash / zsh
CODEX_CWD=/path/to/my-target-repo npm run dev
```

---

## 📡 API 接口说明

- `GET /api/health` — 查看 PTY 进程状态、PID、当前工作目录与连接客户端数。
- `GET /api/git/status` — 获取当前分支及 `git status --porcelain=v1` 变更文件列表。
- `GET /api/git/diff?file=<optional>` — 获取 Unified Diff 原始文本以及通过 `diff2html` 渲染的红绿色块 HTML。
- `POST /api/action` — 发送快捷动作（`approve` / `reject` / `enter` / `esc` / `ctrl_c` / `start_codex`）。
- `WS /ws` — 终端实时双向流与尺寸同步（`input` / `output` / `resize` / `action` / `restart`）。

---

## 📄 License

[MIT](./LICENSE)
