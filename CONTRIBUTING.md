# Contributing / 参与贡献

Please describe the problem, expected behavior, OS, Node version, and minimal reproduction. Redact terminal output, private code, domains, paths, tokens, and QR links before opening an issue. Security reports belong in private reporting; see [SECURITY.md](SECURITY.md).

反馈问题时请提供现象、预期行为、系统、Node 版本及最小复现步骤。请先删除终端中的秘密、私有代码、域名、路径、Token 和配对链接。安全问题请按 [SECURITY.md](SECURITY.md) 私下反馈。

```bash
npm ci --ignore-scripts
npm rebuild node-pty
npm test
npm pack --dry-run
```

Keep changes focused. Add regression coverage for behavior fixes, update both READMEs and `.env.example` when settings change, and preserve the local-only default. Tests must use synthetic credentials and isolated fixtures, without real Cloudflare DNS changes or Codex account access.

请保持修改范围集中。修复行为问题时补充回归测试；配置变更同步更新中英文 README 和 `.env.example`，保留默认仅本机访问。测试使用隔离样例和合成凭据，不修改真实 Cloudflare DNS，也不访问 Codex 账号。
