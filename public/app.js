(() => {
  const STORAGE_KEY = 'codex_relay_auth_token';

  const authOverlay = document.getElementById('auth-overlay');
  const authForm = document.getElementById('auth-form');
  const authTokenInput = document.getElementById('auth-token-input');
  const authError = document.getElementById('auth-error');
  const btnLock = document.getElementById('btn-lock');

  const wsDot = document.getElementById('ws-dot');
  const cwdLabel = document.getElementById('cwd-label');
  const gitBranch = document.getElementById('git-branch');
  const diffCountBadge = document.getElementById('diff-count-badge');
  const terminalContainer = document.getElementById('terminal-container');
  const diffContainer = document.getElementById('diff-container');
  const fileChipsContainer = document.getElementById('file-chips');
  const promptForm = document.getElementById('prompt-form');
  const promptInput = document.getElementById('prompt-input');
  const btnRestart = document.getElementById('btn-restart');
  const btnRefreshDiff = document.getElementById('btn-refresh-diff');

  let activeTab = 'terminal';
  let selectedFile = '';
  let ws = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let authToken = '';
  let isAuthenticated = false;

  // Initialize xterm.js terminal
  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    theme: {
      background: '#090d12',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: 'rgba(88, 166, 255, 0.3)',
    },
    scrollback: 5000,
    convertEol: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalContainer);

  function fitTerminal() {
    if (activeTab !== 'terminal' || !isAuthenticated) return;
    try {
      fitAddon.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          })
        );
      }
    } catch {
      // ignore fit errors when hidden
    }
  }

  window.addEventListener('resize', () => {
    fitTerminal();
  });

  // Forward direct terminal keystrokes to PTY over WebSocket
  term.onData((data) => {
    if (isAuthenticated && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  function hapticFeedback(pattern = 25) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // ignore on unsupported browsers
      }
    }
  }

  function showLockScreen(errorMsg = '') {
    isAuthenticated = false;
    authOverlay.classList.remove('hidden');
    authError.textContent = errorMsg;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    wsDot.classList.remove('connected');
    setTimeout(() => authTokenInput.focus(), 80);
  }

  async function verifyAndUnlock(candidateToken) {
    const cleaned = (candidateToken || '').trim();
    if (!cleaned) {
      showLockScreen('请输入访问密码 / PIN 码');
      return false;
    }

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleaned }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        localStorage.removeItem(STORAGE_KEY);
        showLockScreen(data.error || '访问密码校验失败');
        return false;
      }

      authToken = cleaned;
      isAuthenticated = true;
      localStorage.setItem(STORAGE_KEY, authToken);
      authError.textContent = '';
      authOverlay.classList.add('hidden');

      if (data.cwd) {
        cwdLabel.textContent = data.cwd;
        cwdLabel.title = data.cwd;
      }

      connectWebSocket();
      setTimeout(fitTerminal, 100);
      refreshGitStatusAndDiff();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(refreshGitStatusAndDiff, 4000);
      return true;
    } catch {
      showLockScreen('网络请求失败，无法验证访问密码');
      return false;
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hapticFeedback(20);
    await verifyAndUnlock(authTokenInput.value);
  });

  btnLock.addEventListener('click', () => {
    hapticFeedback(30);
    localStorage.removeItem(STORAGE_KEY);
    authToken = '';
    authTokenInput.value = '';
    term.clear();
    showLockScreen('已安全锁定终端');
  });

  function authFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers || {}, {
      'x-relay-token': authToken,
    });
    return fetch(url, Object.assign({}, options, { headers })).then((res) => {
      if (res.status === 401) {
        localStorage.removeItem(STORAGE_KEY);
        showLockScreen('会话已过期或密码已更改，请重新输入');
      }
      return res;
    });
  }

  function connectWebSocket() {
    if (!isAuthenticated || !authToken) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(authToken)}`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      wsDot.classList.add('connected');
      wsDot.title = 'WebSocket Connected (Authenticated)';
      setTimeout(fitTerminal, 80);
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && typeof msg.data === 'string') {
          term.write(msg.data);
        } else if (msg.type === 'status') {
          if (msg.cwd) {
            cwdLabel.textContent = msg.cwd;
            cwdLabel.title = msg.cwd;
          }
        }
      } catch {
        // ignore invalid frames
      }
    });

    ws.addEventListener('close', () => {
      wsDot.classList.remove('connected');
      wsDot.title = 'Disconnected — Reconnecting...';
      if (isAuthenticated) {
        reconnectTimer = setTimeout(connectWebSocket, 2000);
      }
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function sendAction(action) {
    if (!isAuthenticated) return;
    hapticFeedback(action === 'approve' || action === 'reject' ? [30, 40, 30] : 20);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'action', action }));
    } else {
      authFetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }).catch(() => {});
    }
    setTimeout(refreshGitStatusAndDiff, 600);
  }

  // Bind all buttons with data-action (Approve, Reject, Enter, Esc, Ctrl+C, Run codex)
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      if (action) sendAction(action);
    });
  });

  // Prompt bar submission
  promptForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isAuthenticated) return;
    const text = promptInput.value;
    if (!text.trim()) return;
    hapticFeedback(20);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: `${text}\r` }));
    }
    promptInput.value = '';
    if (activeTab !== 'terminal') {
      switchTab('terminal');
    }
  });

  // Restart PTY session
  btnRestart.addEventListener('click', () => {
    if (!isAuthenticated) return;
    hapticFeedback(35);
    term.clear();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'restart',
          cols: term.cols || 80,
          rows: term.rows || 24,
        })
      );
    }
  });

  // Tab switching logic
  function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isMatch = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    document.getElementById('panel-terminal').classList.toggle('active', tabName === 'terminal');
    document.getElementById('panel-diff').classList.toggle('active', tabName === 'diff');

    if (tabName === 'terminal') {
      setTimeout(fitTerminal, 50);
    } else if (tabName === 'diff') {
      refreshGitStatusAndDiff();
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (targetTab) switchTab(targetTab);
    });
  });

  // Git Status & Diff fetching
  async function refreshGitStatusAndDiff() {
    if (!isAuthenticated) return;
    try {
      const statusRes = await authFetch('/api/git/status');
      if (!statusRes.ok) return;
      const statusData = await statusRes.json();

      if (statusData.ok) {
        gitBranch.textContent = statusData.branch || 'HEAD';
        if (statusData.cwd) {
          cwdLabel.textContent = statusData.cwd;
          cwdLabel.title = statusData.cwd;
        }

        const files = Array.isArray(statusData.files) ? statusData.files : [];
        diffCountBadge.textContent = String(files.length);
        diffCountBadge.classList.toggle('has-changes', files.length > 0);

        renderFileChips(files);
      }

      if (activeTab === 'diff') {
        await loadDiffHtml(selectedFile);
      }
    } catch {
      if (activeTab === 'diff') {
        diffContainer.innerHTML =
          '<div class="empty-state">Unable to load Git status/diff from server.</div>';
      }
    }
  }

  function renderFileChips(files) {
    fileChipsContainer.innerHTML = '';

    const allChip = document.createElement('button');
    allChip.className = `file-chip ${selectedFile === '' ? 'active' : ''}`;
    allChip.textContent = `All (${files.length})`;
    allChip.addEventListener('click', () => {
      selectedFile = '';
      renderFileChips(files);
      loadDiffHtml('');
    });
    fileChipsContainer.appendChild(allChip);

    files.forEach((item) => {
      const chip = document.createElement('button');
      chip.className = `file-chip ${selectedFile === item.file ? 'active' : ''}`;
      chip.textContent = `${item.code} ${item.file}`;
      chip.addEventListener('click', () => {
        selectedFile = item.file;
        renderFileChips(files);
        loadDiffHtml(item.file);
      });
      fileChipsContainer.appendChild(chip);
    });
  }

  async function loadDiffHtml(fileFilter) {
    if (!isAuthenticated) return;
    try {
      const query = fileFilter ? `?file=${encodeURIComponent(fileFilter)}` : '';
      const res = await authFetch(`/api/git/diff${query}`);
      if (!res.ok) return;
      const data = await res.json();

      if (!data.ok) {
        diffContainer.innerHTML = `<div class="empty-state">${data.error || 'Error loading diff'}</div>`;
        return;
      }

      if (!data.hasChanges || !data.html) {
        diffContainer.innerHTML =
          '<div class="empty-state">✨ Working tree clean — no uncommitted changes to preview.</div>';
        return;
      }

      diffContainer.innerHTML = data.html;
    } catch {
      diffContainer.innerHTML =
        '<div class="empty-state">Failed to fetch diff preview.</div>';
    }
  }

  btnRefreshDiff.addEventListener('click', () => {
    hapticFeedback(15);
    refreshGitStatusAndDiff();
  });

  // Boot: Check URL ?token=... (from QR scan) or saved token in localStorage
  (async function initAuth() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      // Strip ?token= from address bar immediately for security
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
      const ok = await verifyAndUnlock(urlToken);
      if (ok) return;
    }

    const savedToken = localStorage.getItem(STORAGE_KEY);
    if (savedToken) {
      const ok = await verifyAndUnlock(savedToken);
      if (ok) return;
    }

    showLockScreen();
  })();
})();
