const { invoke } = window.__TAURI__.core;

// ── State ─────────────────────────────────────────────────
let activeChatId = null;
let config = { provider: 'anthropic', model: 'claude-opus-4-5-20251001', apiKey: '', baseUrl: '' };
let selectedText = '';
let selectedMsgId = null;
let sessionTokens = { in: 0, out: 0 };

// ── Init ──────────────────────────────────────────────────
(async () => {
  const loaded = await invoke('config_load');
  if (loaded) config = { ...config, ...loaded };
  document.getElementById('provider-select').value = config.provider || 'anthropic';
  document.getElementById('model-input').value = config.model || '';
  await refreshChatList();
})();

// ── Toast ─────────────────────────────────────────────────
let toastTimer;
function toast(msg, color = 'var(--accent)') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.color = color;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ── Sidebar toggle ────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const toggle  = document.getElementById('sidebar-toggle');
toggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed');
});

// ── Chat List ─────────────────────────────────────────────
async function refreshChatList() {
  const chats = await invoke('chats_list');
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  chats.forEach(c => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeChatId ? ' active' : '');
    item.dataset.id = c.id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'chat-item-title';
    titleSpan.textContent = c.title;

    const deleteSpan = document.createElement('span');
    deleteSpan.className = 'chat-delete';
    deleteSpan.dataset.id = c.id;
    deleteSpan.textContent = '✕';

    item.appendChild(titleSpan);
    item.appendChild(deleteSpan);

    titleSpan.addEventListener('click', () => loadChat(c.id, c.title));
    deleteSpan.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this chat?')) {
        await invoke('chats_delete', { chatId: c.id });
        if (activeChatId === c.id) { activeChatId = null; clearMain(); }
        await refreshChatList();
      }
    });
    list.appendChild(item);
  });
}

function clearMain() {
  document.getElementById('chat-title').textContent = 'No chat selected';
  document.getElementById('response-area').innerHTML = '<div class="empty-state">Select or create a chat to begin.</div>';
}

// ── New Chat ──────────────────────────────────────────────
document.getElementById('new-chat-btn').addEventListener('click', async () => {
  const id = `chat_${Date.now()}`;
  const title = `Chat ${new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}`;
  await invoke('chats_create', { id, title, provider: config.provider, model: config.model });
  await invoke('hash_load_from_file', { chatId: id });
  await refreshChatList();
  await loadChat(id, title);
});

// ── Load Chat ─────────────────────────────────────────────
async function loadChat(chatId, title = null) {
  activeChatId = chatId;

  if (title) {
    document.getElementById('chat-title').textContent = title;
  } else {
    const chats = await invoke('chats_list');
    const chat = chats.find(c => c.id === chatId);
    document.getElementById('chat-title').textContent = chat?.title || chatId;
  }

  await invoke('hash_load_from_file', { chatId });

  // Reset session tokens
  sessionTokens = { in: 0, out: 0 };
  updateTokenTopbar();

  const messages = await invoke('messages_get', { chatId });
  const area = document.getElementById('response-area');
  area.innerHTML = '';
  if (!messages.length) {
    area.innerHTML = '<div class="empty-state">No messages yet.</div>';
  } else {
    messages.forEach(m => appendMessage(m.role, m.content, false, m.id, !!m.pinned));
  }
  area.scrollTop = area.scrollHeight;

  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === chatId);
  });
}

// ── Render Message ────────────────────────────────────────
function appendMessage(role, content, scroll = true, msgId = null, pinned = false, usage = null, requestSnapshot = null) {
  const area = document.getElementById('response-area');
  const empty = area.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `msg ${role}${pinned ? ' pinned' : ''}`;
  if (msgId) div.dataset.msgId = msgId;
  if (requestSnapshot) div.dataset.snapshot = JSON.stringify(requestSnapshot);

  const roleLabel = role === 'user' ? '▸ USER' : '▸ ASSISTANT';
  const pinBadge = pinned ? ' <span class="pin-badge">📌</span>' : '';
  const inspectBtn = (role === 'assistant' && requestSnapshot)
    ? '<button class="inspect-btn" title="View request">📋</button>'
    : '';

  div.innerHTML = `
    <div class="msg-role">${roleLabel}${pinBadge}${inspectBtn}</div>
    <div class="msg-body">${escHtml(content)}</div>
    ${usage ? `<div class="msg-tokens">↳ in: ${usage.in.toLocaleString()} &nbsp; out: ${usage.out.toLocaleString()} &nbsp; <span class="token-total">total: ${(usage.in + usage.out).toLocaleString()}</span></div>` : ''}
  `;

  if (requestSnapshot) {
    div.querySelector('.inspect-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openInspector(JSON.parse(div.dataset.snapshot), usage);
    });
  }

  area.appendChild(div);
  if (scroll) area.scrollTop = area.scrollHeight;
  return div;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Token Topbar ──────────────────────────────────────────
function updateTokenTopbar() {
  const el = document.getElementById('token-counter');
  if (!el) return;
  const total = sessionTokens.in + sessionTokens.out;
  el.textContent = total > 0
    ? `in: ${sessionTokens.in.toLocaleString()} · out: ${sessionTokens.out.toLocaleString()} · ${total.toLocaleString()} tok`
    : '';
}

// ── Request Inspector ─────────────────────────────────────
function openInspector(snapshot, usage) {
  const modal = document.getElementById('inspector-modal');
  const body  = document.getElementById('inspector-body');
  let html = '';

  if (snapshot.systemPrompt) {
    html += `<div class="insp-section"><div class="insp-label">SYSTEM PROMPT</div><pre>${escHtml(snapshot.systemPrompt)}</pre></div>`;
  }
  if (snapshot.messages?.length) {
    html += `<div class="insp-section"><div class="insp-label">MESSAGES SENT (${snapshot.messages.length})</div>`;
    snapshot.messages.forEach(m => {
      html += `<div class="insp-msg ${m.role}"><span class="insp-role">${m.role.toUpperCase()}</span><pre>${escHtml(m.content)}</pre></div>`;
    });
    html += `</div>`;
  }
  if (usage) {
    html += `<div class="insp-section"><div class="insp-label">TOKEN USAGE</div>
      <div class="insp-tokens">
        <span>Input: <b>${usage.in.toLocaleString()}</b></span>
        <span>Output: <b>${usage.out.toLocaleString()}</b></span>
        <span>Total: <b>${(usage.in + usage.out).toLocaleString()}</b></span>
      </div></div>`;
  }

  body.innerHTML = html;
  modal.classList.remove('hidden');
}

// ── Send Message ──────────────────────────────────────────
let isSending = false;
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function buildSystemPrompt(userQuery) {
  const [hash, ragContext] = await invoke('context_load_parallel', { chatId: activeChatId, query: userQuery });
  const hashEntries = Object.entries(hash);
  let system = '';
  if (hashEntries.length) {
    system += '[HASH CONTEXT]\n';
    system += hashEntries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    system += '\n[/HASH CONTEXT]\n\n';
  }
  if (ragContext) {
    system += '[RAG CONTEXT]\n' + ragContext + '\n[/RAG CONTEXT]\n\n';
  }
  return system.trim() || null;
}

async function buildMessageWindow(currentText) {
  const raw = document.getElementById('window-select').value;
  const n = raw === 'all' ? Infinity : parseInt(raw, 10);

  const pinned = await invoke('messages_get_pinned', { chatId: activeChatId });
  const slidingMsgs = n === Infinity
    ? await invoke('messages_get', { chatId: activeChatId })
    : n > 0 ? await invoke('messages_get_window', { chatId: activeChatId, n }) : [];

  const seen = new Set();
  const merged = [];
  for (const m of [...pinned, ...slidingMsgs]) {
    if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  merged.sort((a, b) => a.timestamp - b.timestamp);

  const msgs = merged.map(m => ({ role: m.role, content: m.content }));
  msgs.push({ role: 'user', content: currentText });
  return msgs;
}

async function sendMessage() {
  if (!activeChatId) { toast('No chat selected', 'var(--warn)'); return; }
  if (isSending) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  isSending = true;
  document.getElementById('send-btn').disabled = true;

  let systemPrompt, msgs;
  try {
    systemPrompt = await buildSystemPrompt(text);
    msgs = await buildMessageWindow(text);
  } catch (err) {
    isSending = false;
    document.getElementById('send-btn').disabled = false;
    toast(`Context error: ${err}`, 'var(--danger)');
    return;
  }

  input.value = '';

  try {
    const userMsgId = await invoke('messages_add', { chatId: activeChatId, role: 'user', content: text });
    appendMessage('user', text, true, userMsgId);

    const area = document.getElementById('response-area');
    const typing = document.createElement('div');
    typing.className = 'msg assistant';
    typing.innerHTML = '<div class="msg-role">▸ ASSISTANT</div><div class="msg-body"><span class="typing-dot">█</span></div>';
    area.appendChild(typing);
    area.scrollTop = area.scrollHeight;

    const { reply, usage } = await callLLM(msgs, systemPrompt);
    typing.remove();

    sessionTokens.in  += usage.in;
    sessionTokens.out += usage.out;
    updateTokenTopbar();

    const asstMsgId = await invoke('messages_add', { chatId: activeChatId, role: 'assistant', content: reply });
    const snapshot = { systemPrompt, messages: msgs };
    appendMessage('assistant', reply, true, asstMsgId, false, usage, snapshot);
  } catch (err) {
    document.querySelector('.typing-dot')?.closest('.msg')?.remove();
    appendMessage('assistant', `[ERROR] ${err}`);
  } finally {
    isSending = false;
    document.getElementById('send-btn').disabled = false;
  }
}

// ── LLM API Call ──────────────────────────────────────────
async function callLLM(messages, systemPrompt = null) {
  const provider = document.getElementById('provider-select').value;
  const model    = document.getElementById('model-input').value || config.model;
  const apiKey   = config.apiKey;

  if (!apiKey) throw new Error('No API key set. Open Settings.');

  if (provider === 'anthropic') {
    const body = { model, max_tokens: 2048, messages };
    if (systemPrompt) body.system = systemPrompt;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Anthropic API error');
    return {
      reply: data.content[0].text,
      usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 }
    };

  } else if (provider === 'openai' || provider === 'groq' || provider === 'custom') {
    const baseUrl = config.baseUrl ||
      (provider === 'openai' ? 'https://api.openai.com/v1' :
       provider === 'groq'   ? 'https://api.groq.com/openai/v1' : '');
    const msgsWithSystem = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: msgsWithSystem, max_tokens: 2048 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'API error');
    return {
      reply: data.choices[0].message.content,
      usage: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 }
    };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── Selection Actions ─────────────────────────────────────
document.addEventListener('mouseup', () => {
  const sel = window.getSelection()?.toString().trim();
  if (sel) {
    selectedText = sel;
    const msgEl = window.getSelection()?.anchorNode?.parentElement?.closest('.msg');
    selectedMsgId = msgEl?.dataset.msgId ? parseInt(msgEl.dataset.msgId, 10) : null;
    const pinBtn = document.getElementById('ctx-pin');
    if (msgEl) {
      pinBtn.textContent = msgEl.classList.contains('pinned') ? '📌 Unpin' : '📌 Pin';
      pinBtn.style.display = '';
    } else {
      pinBtn.style.display = 'none';
    }
  }
});

document.getElementById('ctx-copy').addEventListener('click', () => {
  if (!selectedText) { toast('No text selected', 'var(--warn)'); return; }
  navigator.clipboard.writeText(selectedText);
  toast('Copied');
});

document.getElementById('ctx-pin').addEventListener('click', async () => {
  if (!activeChatId || !selectedMsgId) { toast('Select text inside a message', 'var(--warn)'); return; }
  const msgEl = document.querySelector(`.msg[data-msg-id="${selectedMsgId}"]`);
  const isPinned = msgEl?.classList.contains('pinned');
  if (isPinned) {
    await invoke('messages_unpin', { chatId: activeChatId, msgId: selectedMsgId });
    msgEl?.classList.remove('pinned');
    msgEl?.querySelector('.pin-badge')?.remove();
    document.getElementById('ctx-pin').textContent = '📌 Pin';
    toast('Unpinned');
  } else {
    await invoke('messages_pin', { chatId: activeChatId, msgId: selectedMsgId });
    msgEl?.classList.add('pinned');
    const roleEl = msgEl?.querySelector('.msg-role');
    if (roleEl && !roleEl.querySelector('.pin-badge')) {
      roleEl.insertAdjacentHTML('beforeend', ' <span class="pin-badge">📌</span>');
    }
    document.getElementById('ctx-pin').textContent = '📌 Unpin';
    toast('📌 Pinned to context');
  }
});

document.getElementById('ctx-rag').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  if (!selectedText) { toast('No text selected', 'var(--warn)'); return; }
  toast('Formatting for RAG...', 'var(--warn)');
  try {
    const { reply: formatted } = await callLLM([
      { role: 'user', content: `Format the following text as a concise RAG knowledge chunk. Return ONLY the formatted chunk, no preamble:\n\n${selectedText}` }
    ], 'You are a RAG formatting assistant. Convert text into clean, factual knowledge chunks optimized for retrieval. Return only the chunk text.');
    await invoke('rag_add', { chatId: activeChatId, chunk: formatted });
    toast('✓ Saved to RAG');
  } catch (err) {
    toast(`RAG error: ${err}`, 'var(--danger)');
  }
});

document.getElementById('ctx-hash').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  if (!selectedText) { toast('No text selected', 'var(--warn)'); return; }
  toast('Formatting for Hash...', 'var(--warn)');
  try {
    const { reply: raw } = await callLLM([
      { role: 'user', content: `Extract key-value pairs from this text. Return ONLY valid JSON object (no markdown, no explanation):\n\n${selectedText}` }
    ], 'You are a hash extraction assistant. Extract structured key-value pairs from text. Return only a flat JSON object.');
    const clean = raw.replace(/```json|```/g, '').trim();
    let entry;
    try { entry = JSON.parse(clean); }
    catch { throw new Error('LLM did not return valid JSON. Try selecting different text.'); }
    await invoke('hash_add_entry', { chatId: activeChatId, entry });
    toast('✓ Saved to Hash');
  } catch (err) {
    toast(`Hash error: ${err}`, 'var(--danger)');
  }
});

// ── Hash Flush ────────────────────────────────────────────
document.getElementById('hash-flush-btn').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  await invoke('hash_flush', { chatId: activeChatId });
  toast('✓ Hash written to disk');
});

// ── Click outside to close any modal ─────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});

// ── RAG Viewer ────────────────────────────────────────────
document.getElementById('view-rag-btn').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  const chunks = await invoke('rag_load', { chatId: activeChatId });
  const body = document.getElementById('rag-body');
  if (!chunks.length) {
    body.innerHTML = '<div class="viewer-empty">No RAG chunks yet.</div>';
  } else {
    body.innerHTML = chunks.map((c, i) => `
      <div class="viewer-item" data-rag-id="${c.id}">
        <div class="viewer-item-meta">#${i + 1} · ${new Date(c.added).toLocaleString()}</div>
        <div class="viewer-item-content">${escHtml(c.content)}</div>
        <button class="viewer-delete-btn" data-rag-id="${c.id}">✕ Delete</button>
      </div>
    `).join('');
    body.querySelectorAll('.viewer-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ragId = parseInt(btn.dataset.ragId, 10);
        const all = await invoke('rag_load', { chatId: activeChatId });
        const updated = all.filter(c => c.id !== ragId);
        await invoke('rag_save', { chatId: activeChatId, chunks: updated });
        btn.closest('.viewer-item').remove();
        toast('✓ Chunk deleted');
      });
    });
  }
  document.getElementById('rag-modal').classList.remove('hidden');
});
document.getElementById('rag-close-btn').addEventListener('click', () => {
  document.getElementById('rag-modal').classList.add('hidden');
});

// ── Hash Viewer ───────────────────────────────────────────
document.getElementById('view-hash-btn').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  const hash = await invoke('hash_get', { chatId: activeChatId });
  const body = document.getElementById('hash-body');
  const entries = Object.entries(hash);
  if (!entries.length) {
    body.innerHTML = '<div class="viewer-empty">Hash is empty.</div>';
  } else {
    body.innerHTML = `<table class="hash-table">
      <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
      <tbody>
        ${entries.map(([k, v]) => `
          <tr data-key="${escHtml(k)}">
            <td class="hash-key">${escHtml(k)}</td>
            <td class="hash-val" contenteditable="true">${escHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>
            <td><button class="viewer-delete-btn hash-del" data-key="${escHtml(k)}">✕</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <button class="btn-primary" id="hash-save-edits-btn" style="margin-top:10px">Save Edits</button>`;

    body.querySelector('#hash-save-edits-btn').addEventListener('click', async () => {
      const rows = body.querySelectorAll('tbody tr');
      for (const row of rows) {
        const key = row.dataset.key;
        const val = row.querySelector('.hash-val').textContent.trim();
        let parsed;
        try { parsed = JSON.parse(val); } catch { parsed = val; }
        await invoke('hash_set', { chatId: activeChatId, key, value: parsed });
      }
      toast('✓ Hash updated');
    });

    body.querySelectorAll('.hash-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        await invoke('hash_delete', { chatId: activeChatId, key });
        btn.closest('tr').remove();
        toast('✓ Key deleted');
      });
    });
  }
  document.getElementById('hash-modal').classList.remove('hidden');
});
document.getElementById('hash-close-btn').addEventListener('click', () => {
  document.getElementById('hash-modal').classList.add('hidden');
});

// ── Pinned Viewer ─────────────────────────────────────────
document.getElementById('view-pinned-btn').addEventListener('click', async () => {
  if (!activeChatId) { toast('No active chat', 'var(--warn)'); return; }
  const pinned = await invoke('messages_get_pinned', { chatId: activeChatId });
  const body = document.getElementById('pinned-body');
  if (!pinned.length) {
    body.innerHTML = '<div class="viewer-empty">No pinned messages.</div>';
  } else {
    body.innerHTML = pinned.map(m => `
      <div class="viewer-item">
        <div class="viewer-item-meta">${m.role.toUpperCase()} · ${new Date(m.timestamp).toLocaleString()}</div>
        <div class="viewer-item-content">${escHtml(m.content)}</div>
        <button class="viewer-delete-btn" data-msg-id="${m.id}">✕ Unpin</button>
      </div>
    `).join('');
    body.querySelectorAll('.viewer-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msgId = parseInt(btn.dataset.msgId, 10);
        await invoke('messages_unpin', { chatId: activeChatId, msgId });
        const msgEl = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
        msgEl?.classList.remove('pinned');
        msgEl?.querySelector('.pin-badge')?.remove();
        btn.closest('.viewer-item').remove();
        toast('Unpinned');
      });
    });
  }
  document.getElementById('pinned-modal').classList.remove('hidden');
});
document.getElementById('pinned-close-btn').addEventListener('click', () => {
  document.getElementById('pinned-modal').classList.add('hidden');
});

// ── Inspector Modal ───────────────────────────────────────
document.getElementById('inspector-close-btn').addEventListener('click', () => {
  document.getElementById('inspector-modal').classList.add('hidden');
});

// ── Settings ──────────────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('api-key-input').value = config.apiKey || '';
  document.getElementById('base-url-input').value = config.baseUrl || '';
  document.getElementById('settings-modal').classList.remove('hidden');
});

document.getElementById('settings-cancel-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.add('hidden');
});

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  config.apiKey   = document.getElementById('api-key-input').value.trim();
  config.baseUrl  = document.getElementById('base-url-input').value.trim();
  config.provider = document.getElementById('provider-select').value;
  config.model    = document.getElementById('model-input').value.trim();
  await invoke('config_save', { cfg: config });
  document.getElementById('settings-modal').classList.add('hidden');
  toast('✓ Settings saved');
});

document.getElementById('provider-select').addEventListener('change', e => { config.provider = e.target.value; });
document.getElementById('model-input').addEventListener('input', e => { config.model = e.target.value; });
