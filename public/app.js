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
  const promptStatus = document.getElementById('prompt-status');
  const btnSend = document.getElementById('btn-send');
  const btnQr = document.getElementById('btn-qr');
  const terminalState = document.getElementById('terminal-state');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)) btnQr.hidden = true;

  let activeTab = 'terminal';
  let selectedFile = '';
  let ws = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let authToken = '';
  let isAuthenticated = false;
  let pendingPrompt = null;
  let pendingTimer = null;
  let terminalRunning = null;
  let lastViewportSize = '';
  const renderQueue = [];
  let rendering = false;

  function setPromptStatus(message, sending = false) {
    promptStatus.textContent = message;
    btnSend.disabled = sending;
  }

  function preservePendingPrompt(message) {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pendingPrompt) pendingPrompt.waiting = false;
    setPromptStatus(message);
  }

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

  function renderTerminal(operation) {
    renderQueue.push(operation);
    drainTerminal();
  }

  function drainTerminal() {
    if (rendering || !renderQueue.length) return;
    rendering = true;
    const operation = renderQueue.shift();
    const finish = () => { rendering = false; drainTerminal(); };
    try {
      if (operation.type === 'history' || operation.type === 'session-reset') {
        term.reset();
        if (Number.isInteger(operation.cols) && Number.isInteger(operation.rows)) {
          term.resize(operation.cols, operation.rows);
        }
      }
      // A reset/resize must wait for preceding asynchronous terminal writes.
      if (typeof operation.data === 'string' && operation.data.length) term.write(operation.data, finish);
      else finish();
    } catch { finish(); }
  }

  function fitTerminal() {
    if (activeTab !== 'terminal' || !isAuthenticated) return;
    try {
      // Measure without resizing independently: every browser uses one grid.
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const sizeKey = `${dimensions.cols}:${dimensions.rows}`;
        if (sizeKey === lastViewportSize) return;
        lastViewportSize = sizeKey;
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: dimensions.cols,
            rows: dimensions.rows,
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
  window.visualViewport?.addEventListener('resize', fitTerminal);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitTerminal).observe(terminalContainer);

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
      const previous = ws;
      ws = null;
      try {
        previous.close();
      } catch {}
    }
    preservePendingPrompt('');
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
    renderQueue.length = 0;
    renderTerminal({ type: 'session-reset' });
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
    if (ws) {
      const previous = ws;
      ws = null;
      previous.close();
    }
    const connection = new WebSocket(wsUrl);
    ws = connection;
    lastViewportSize = '';

    connection.addEventListener('open', () => {
      if (ws !== connection) return;
      wsDot.classList.add('connected');
      wsDot.title = 'WebSocket Connected (Authenticated)';
      setTimeout(fitTerminal, 80);
    });

    connection.addEventListener('message', (event) => {
      if (ws !== connection) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'history' && typeof msg.data === 'string') {
          renderTerminal(msg);
        } else if (msg.type === 'output' && typeof msg.data === 'string') {
          renderTerminal(msg);
        } else if (msg.type === 'session-reset') {
          renderTerminal(msg);
          if (pendingPrompt) {
            pendingPrompt = null;
            preservePendingPrompt('终端已重启，输入已保留；请检查后重新发送');
          }
        } else if (msg.type === 'input-ack' && pendingPrompt && msg.id === pendingPrompt.id) {
          if (promptInput.value === pendingPrompt.text) promptInput.value = '';
          pendingPrompt = null;
          preservePendingPrompt('已发送到终端');
        } else if (msg.type === 'input-error' && pendingPrompt && msg.id === pendingPrompt.id) {
          preservePendingPrompt('发送未成功，输入已保留，请检查终端后重试');
        } else if (msg.type === 'status') {
          if (typeof msg.running === 'boolean') {
            terminalRunning = msg.running;
            terminalState.hidden = msg.running;
            terminalState.textContent = msg.running ? '' : msg.kind === 'normal'
              ? '终端会话已正常结束。点击 Restart 新建会话。'
              : msg.kind === 'error' ? '终端会话已结束，请检查上方输出，再点击 Restart。'
              : '终端连接已关闭，系统未提供退出状态。点击 Restart 重新连接。';
          }
          if (msg.cwd) {
            cwdLabel.textContent = msg.cwd;
            cwdLabel.title = msg.cwd;
          }
        }
      } catch {
        // ignore invalid frames
      }
    });

    connection.addEventListener('close', () => {
      if (ws !== connection) return;
      ws = null;
      if (pendingPrompt) preservePendingPrompt('连接已断开，输入已保留；重连后可重试');
      wsDot.classList.remove('connected');
      wsDot.title = 'Disconnected — Reconnecting...';
      if (isAuthenticated) {
        reconnectTimer = setTimeout(connectWebSocket, 2000);
      }
    });

    connection.addEventListener('error', () => {
      connection.close();
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
    if (terminalRunning === false) {
      setPromptStatus('终端已关闭，输入已保留，请先点击 Restart');
      return;
    }
    if (pendingPrompt?.waiting) return;
    hapticFeedback(20);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setPromptStatus('尚未连接，输入已保留，请等待重连');
      return;
    }
    if (text.length >= 16 * 1024) {
      setPromptStatus('输入过长，请拆分为少于 16K 字符的消息');
      return;
    }
    const id = pendingPrompt?.text === text ? pendingPrompt.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    pendingPrompt = { id, text, waiting: true };
    setPromptStatus('发送中…', true);
    try {
      ws.send(JSON.stringify({ type: 'input', id, data: `${text}\r` }));
      pendingTimer = setTimeout(() => preservePendingPrompt('尚未收到确认，输入已保留；查看终端后可重试'), 7000);
    } catch {
      preservePendingPrompt('连接不可用，输入已保留');
    }
    if (activeTab !== 'terminal') {
      switchTab('terminal');
    }
  });

  // Restart PTY session
  btnRestart.addEventListener('click', () => {
    if (!isAuthenticated) return;
    hapticFeedback(35);
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
      if (!statusRes.ok) throw new Error('Git status unavailable');
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
    if (selectedFile && !files.some(item => item.file === selectedFile)) selectedFile = '';
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
        diffContainer.textContent = data.error || 'Error loading diff';
        return;
      }

      if (!data.hasChanges) {
        diffContainer.innerHTML =
          '<div class="empty-state">✨ Working tree clean — no uncommitted changes to preview.</div>';
        return;
      }

      if (!data.html) {
        diffContainer.textContent = 'Changes exist, but no text preview is available. Check the file list and local Git diff.';
        return;
      }

      diffContainer.innerHTML = data.html;
      if (data.omittedFiles?.length) {
        const notice = document.createElement('p');
        notice.className = 'preview-notice';
        notice.textContent = `Preview omitted: ${data.omittedFiles.map(item => `${item.file} (${item.reason})`).join(', ')}`;
        diffContainer.prepend(notice);
      }
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
