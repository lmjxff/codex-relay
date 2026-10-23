# 🚀 codex-relay

> **专为手机端远程控制本地 OpenAI Codex CLI、支持 Cloudflare Tunnel 外网穿透、双端查看代码 Diff 并一键审批的轻量级开源桥接器。**  
> A lightweight mobile-first web bridge for remote-controlling local OpenAI Codex CLI with Cloudflare Tunnel custom domain support, PIN/Token security lock, HD SVG QR code launchpad, real-time `xterm.js` streaming, `diff2html` Git Diff preview, and thumb-friendly one-tap approval.

---

## ✨ 核心特性 (Features)

- **🌍 内置 Cloudflare Tunnel 内网穿透 + 自动 DNS 路由**：
  - 支持直接绑定你的自定义 Cloudflare 二级域名（默认配置 `codex.lmjjml.cc.cd`，可在 `.env` 修改为任意子域名，无需手动去 Cloudflare 后台建解析，程序启动时自动创建 CNAME 路由）。
  - 若尚未执行首次域名授权，自动无缝回退至 `*.trycloudflare.com` 临时公网加密隧道，开箱即用。
- **📱 浏览器高清矢量二维码面板 (`/qr`)**：
  - 启动服务时自动在电脑浏览器弹出 `http://localhost:3210/qr` 高清双二维码面板（同时提供 **🌍 外网 4G/5G 远程连接码** 与 **📶 局域网 Wi-Fi 秒连码**），彻底解决 Windows 终端字符二维码变形无法识别的问题。
  - 手机相机或浏览器扫一扫即可**免输密码一键自动登录**。
- **🔒 三重安全防护机制**：
  1. **网页端 PIN / Token 密码锁**：未授权访问会被全屏毛玻璃安全锁拦截；支持在 `.env` 配置 `RELAY_AUTH_TOKEN` 或首次启动时设定 PIN 码（自动持久化至 `.env`）；扫码进入后自动抹除地址栏 `?token=` 参数防止截图泄密；内置同 IP 连续输错防爆破限流（8 次失败封禁 5 分钟）与常量时间哈希比对 (`crypto.timingSafeEqual`)。
  2. **WebSocket 连接级隔离**：每次建立 `/ws` 双向流连接时在底层 HTTP `upgrade` 握手阶段强制校验 Token，严厉拒绝任何未授权陌生 IP 连接（直接返回 `401 Unauthorized` 并销毁底层 Socket）。
  3. **进程生命周期强绑定**：当你在电脑上关闭终端或按 `Ctrl+C` 退出时，自动立即销毁 `cloudflared` 隧道进程与 `node-pty` 进程，公网链接瞬间失效，杜绝后台残留暴露风险。
- **🖥️ 实时终端双向流 (`node-pty` + `ws` + `xterm.js`)**：在本地托管 OpenAI `codex` CLI 终端会话，内置 64KB 环形输出缓存，手机切后台或锁屏重连后自动恢复上下文。
- **👍 专为单手握持设计的大号拇指审批区**：下半屏配备超大尺寸 **`[Approve (y)]`** 与 **`[Reject (n)]`** 按钮（带手机触觉震动反馈）。
- **🔀 红绿色块代码 Diff 预览 (`diff2html`)**：内置 `[Git Diff]` 标签页，实时展示工作区红绿高亮代码差异（含未跟踪新文件预览）并支持按文件筛选。

---

## 🚀 快速开始 (Quick Start)

### 1. 克隆并安装依赖

```bash
git clone https://github.com/lmjxff/codex-relay.git
cd codex-relay
npm install
```

### 2. 首次授权绑定你的 Cloudflare 域名（如 `lmjjml.cc.cd`）

**方式 A：一行命令网页授权（最推荐，仅需首次执行一次）**

```bash
npm run cf:login
```

运行后会自动弹出浏览器 Cloudflare 授权页，选择你的主域名（如 **`lmjjml.cc.cd`**）并点击 **Authorize**。授权证书会自动保存在 `~/.cloudflared/cert.pem`。  
此后每次启动 `codex-relay`，程序都会自动创建命名隧道并将子域名（如 **`https://codex.lmjjml.cc.cd`**）自动配置好 DNS CNAME 解析并指向你的本地服务！

**方式 B：使用 Cloudflare Zero Trust 后台 Token**

如果你在 Cloudflare Zero Trust 控制台手动管理 Tunnel，只需在 `.env` 中填入：

```env
CF_HOSTNAME=codex.lmjjml.cc.cd
CF_TUNNEL_TOKEN=eyJhIjoi...
```

> 💡 **免配置体验**：即使你还没执行 `npm run cf:login`，直接运行 `npm start` 也会自动生成一个免配置的 `https://xxxx.trycloudflare.com` 临时公网加密链接与二维码！

### 3. 一键启动服务与手机扫码连接

```bash
# 标准启动
npm start

# 或开发热重载模式
npm run dev

# 或编译后通过 npx 启动
npm run build
npx codex-relay
```

启动流程：
1. **首次安全设置**：若 `.env` 中尚未设置 `RELAY_AUTH_TOKEN`，首次启动会提示你输入自定义 PIN 码（直接回车则自动生成 6 位安全数字 PIN 并保存至 `.env`，后续启动自动沿用）。
2. **自动弹出高清二维码页**：服务启动后会自动在电脑浏览器打开 **`http://localhost:3210/qr`**（也可随时点击控制台右上角 **`📱 扫码`** 按钮打开），页面包含：
   - **🌍 外网 4G/5G 远程连接二维码**：出门在外使用手机流量扫码即连（注：国内移动网络裸连海外 Cloudflare 节点若遇阻断或超时，开启手机端代理软件即可秒开）。
   - **📶 同一 Wi-Fi 局域网秒连二维码**：在家或办公室连同一 Wi-Fi 时扫码，零延迟直连。
3. **扫码即用**：手机扫码后自动完成 Token 校验并隐藏地址栏密码参数，直接进入终端与 Diff 审批界面；点击右上角 **`🔒`** 按钮可随时手动锁定退出。

---

## ⚙️ 环境变量配置 (`.env`)

可复制 [`.env.example`](./.env.example) 为 `.env` 进行自定义配置：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `RELAY_AUTH_TOKEN` | 首次启动设定/自动生成 | 网页端与 WebSocket 必须校验的访问密码 / PIN 码 |
| `ENABLE_TUNNEL` | `true` | 是否在启动时自动拉起 Cloudflare Tunnel 公网穿透 |
| `AUTO_OPEN_QR` | `true` | 启动时是否在电脑浏览器自动打开 `/qr` 高清扫码页面 |
| `CF_HOSTNAME` | `codex.lmjjml.cc.cd` | 绑定的 Cloudflare 自定义二级域名 |
| `CF_TUNNEL_NAME` | `codex-relay` | Cloudflare 命名隧道名称 |
| `CF_TUNNEL_TOKEN` | 空 | 可选：Cloudflare Zero Trust 隧道 Token |
| `PORT` | `3210` | 本地 HTTP / WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 绑定网卡地址（自动过滤 Mihomo/WSL 等虚拟网卡识别真实局域网 IP） |
| `CODEX_CWD` | 当前工作目录 | 要让 Codex 操作的目标 Git 仓库路径 |
| `CODEX_CMD` | `codex` | 启动后自动执行的 CLI 命令 |
| `AUTO_START_CODEX` | `true` | 启动 PTY 后是否自动输入并执行 `CODEX_CMD` |

---

## 📡 API 与页面路由说明

- `GET /qr` — 电脑本机免密直达的高清双二维码扫码页（外网请求需携带有效 Token）。
- `POST /api/auth/verify` — 校验访问密码 / PIN 码（带防暴力破解限流保护）。
- `GET /api/qr` — 获取当前公网与局域网免密直连链接及 SVG 矢量二维码（需鉴权）。
- `GET /api/health` — 查看 PTY 进程状态、PID、工作目录与公网隧道状态（需鉴权）。
- `GET /api/git/status` — 获取当前分支及 `git status --porcelain=v1` 变更文件列表（需鉴权）。
- `GET /api/git/diff?file=<optional>` — 获取 Unified Diff 文本及 `diff2html` 渲染的红绿色块 HTML（需鉴权）。
- `POST /api/action` — 发送快捷动作（`approve` / `reject` / `enter` / `esc` / `ctrl_c` / `start_codex`，需鉴权）。
- `WS /ws?token=<PIN>` — 终端实时双向流与尺寸同步（握手阶段强制校验 Token 隔离连接）。

---

## 📄 License

[MIT](./LICENSE)
