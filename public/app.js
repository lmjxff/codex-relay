(() => {
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
    if (activeTab !== 'terminal') return;
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
    if (ws && ws.readyState === WebSocket.OPEN) {
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

  function connectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      wsDot.classList.add('connected');
      wsDot.title = 'WebSocket Connected';
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
      reconnectTimer = setTimeout(connectWebSocket, 1800);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function sendAction(action) {
    hapticFeedback(action === 'approve' || action === 'reject' ? [30, 40, 30] : 20);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'action', action }));
    } else {
      fetch('/api/action', {
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
    try {
      const statusRes = await fetch('/api/git/status');
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
    try {
      const query = fileFilter ? `?file=${encodeURIComponent(fileFilter)}` : '';
      const res = await fetch(`/api/git/diff${query}`);
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

  // Boot
  connectWebSocket();
  setTimeout(fitTerminal, 120);
  refreshGitStatusAndDiff();
  setInterval(refreshGitStatusAndDiff, 4000);
})();
