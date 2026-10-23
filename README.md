# 🚀 codex-relay

> **专为手机端远程控制本地 OpenAI Codex CLI、支持 Cloudflare Tunnel 外网穿透、双端查看代码 Diff 并一键审批的轻量级开源桥接器。**  
> A lightweight mobile-first web bridge for remote-controlling local OpenAI Codex CLI with Cloudflare Tunnel custom domain support, PIN/Token security lock, real-time `xterm.js` streaming, `diff2html` Git Diff preview, and thumb-friendly one-tap approval.

---

## ✨ 核心特性 (Features)

- **🌍 内置 Cloudflare Tunnel 内网穿透 + 终端二维码**：
  - 支持直接绑定你的自定义 Cloudflare 二级域名（默认配置 `codex.lmjjml.cc.cd`，可在 `.env` 修改为任意子域名）。
  - 启动时自动在终端打印**带访问密码的公网 HTTPS 链接与二维码**，出门在外使用手机 **4G/5G 流量**扫码即可一键登录控制。
  - 若尚未执行域名登录授权，自动无缝回退至 `*.trycloudflare.com` 临时公网隧道，真正做到开箱即用。
- **🔒 三重安全防护机制**：
  1. **网页端 PIN / Token 密码锁**：未授权访问会被安全锁界面拦截，支持在 `.env` 配置 `RELAY_AUTH_TOKEN` 或首次启动时交互式设置 PIN 码；内置同 IP 连续输错防爆破限流（8 次失败封禁 5 分钟）与常量时间哈希比对 (`crypto.timingSafeEqual`)。
  2. **WebSocket 连接级隔离**：每次建立 `/ws` 双向流连接时在底层 HTTP Upgrade 握手阶段强制校验 Token，严厉拒绝任何未授权陌生 IP 连接（直接返回 `401 Unauthorized` 并销毁 Socket）。
  3. **进程生命周期强绑定**：当你在电脑上关闭终端或按 `Ctrl+C` 退出时，自动立即销毁 `cloudflared` 隧道进程与 `node-pty` 进程，公网链接瞬间失效，杜绝后台残留暴露风险。
- **🖥️ 实时终端双向流 (`node-pty` + `ws` + `xterm.js`)**：在本地托管 OpenAI `codex` CLI 终端会话，内置 64KB 环形输出缓存，手机切后台或锁屏重连后自动恢复上下文。
- **👍 专为单手握持设计的大号拇指审批区**：下半屏配备超大尺寸 **`[Approve (y)]`** 与 **`[Reject (n)]`** 按钮（带手机触觉震动反馈）。
- **🔀 红绿色块代码 Diff 预览 (`diff2html`)**：内置 `[Git Diff]` 标签页，实时展示工作区红绿高亮代码差异（含未跟踪新文件预览）并支持按文件筛选。

---

## 🚀 快速开始 (Quick Start)

### 1. 安装依赖

```bash
git clone https://github.com/lmjxff/codex-relay.git
cd codex-relay
npm install
```

### 2. 绑定你的 Cloudflare 自定义域名（如 `codex.lmjjml.cc.cd`）

**方式 A：一行命令扫码/网页授权（最推荐，仅需首次执行一次）**

```bash
npm run cf:login
```

运行后会自动弹出浏览器 Cloudflare 授权页，选择你的域名 **`lmjjml.cc.cd`** 并点击 **Authorize**。授权证书会自动保存在 `~/.cloudflared/cert.pem`。  
此后每次启动 `codex-relay`，程序都会自动创建隧道并将 **`https://codex.lmjjml.cc.cd`** 路由到你的本地服务！

**方式 B：使用 Cloudflare Zero Trust 后台 Token**

如果你在 Cloudflare Zero Trust 控制台创建了 Tunnel，只需在 `.env` 中填入：

```env
CF_HOSTNAME=codex.lmjjml.cc.cd
CF_TUNNEL_TOKEN=eyJhIjoi...
```

> 💡 **免配置体验**：即使你还没执行 `npm run cf:login`，直接启动 `npm start` 或 `npm run dev` 也会自动为你生成一个免配置的 `https://xxxx.trycloudflare.com` 公网加密链接与二维码！

### 3. 一键启动服务

```bash
# 开发热重载模式
npm run dev

# 或标准启动
npm start

# 或编译后通过 npx 启动
npm run build
npx codex-relay
```

启动后：
1. 若 `.env` 中尚未设置 `RELAY_AUTH_TOKEN`，首次启动会提示你输入自定义 PIN 码（直接回车则自动生成 6 位安全数字 PIN 并保存至 `.env`）。
2. 终端会打印 **公网 HTTPS 地址**、**访问密码** 以及 **免输密一键登录二维码**。
3. 手机在 **4G/5G 移动网络** 下直接用相机或微信扫描终端上的二维码，即可自动完成鉴权并进入操作界面！

---

## ⚙️ 环境变量配置 (`.env`)

可复制 `.env.example` 为 `.env` 进行自定义配置：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `RELAY_AUTH_TOKEN` | 首次启动设定/自动生成 | 网页端与 WebSocket 必须校验的访问密码 / PIN 码 |
| `ENABLE_TUNNEL` | `true` | 是否在启动时自动拉起 Cloudflare Tunnel 公网穿透 |
| `CF_HOSTNAME` | `codex.lmjjml.cc.cd` | 绑定的 Cloudflare 自定义二级域名 |
| `CF_TUNNEL_NAME` | `codex-relay` | Cloudflare 命名隧道名称 |
| `CF_TUNNEL_TOKEN` | 空 | 可选：Cloudflare Zero Trust 隧道 Token |
| `PORT` | `3210` | 本地 HTTP / WebSocket 监听端口 |
| `CODEX_CWD` | 当前工作目录 | 要让 Codex 操作的目标 Git 仓库路径 |
| `CODEX_CMD` | `codex` | 启动后自动执行的 CLI 命令 |

---

## 📄 License

[MIT](./LICENSE)
