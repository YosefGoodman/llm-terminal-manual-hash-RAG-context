# LLM Terminal (Tauri)

Lightweight LLM chat interface. ~8MB bundle vs ~150MB Electron.

## Requirements

### All platforms
- Node.js 18+ → https://nodejs.org
- Rust → https://rustup.rs

### Windows (additional)
- Visual Studio Build Tools with "Desktop development with C++" workload
  → https://visualstudio.microsoft.com/visual-cpp-build-tools/
- WebView2 Runtime (pre-installed on Windows 10/11)

### macOS (additional)
- Xcode Command Line Tools: `xcode-select --install`

## Install & Run

```bash
npm install
npm run dev       # development
npm run build     # production build
```

First build takes 5-10 min (Rust compilation). Subsequent builds are faster.

## Data Location

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\com.llmterminal.app\llm-terminal\` |
| macOS | `~/Library/Application Support/com.llmterminal.app/llm-terminal/` |

```
master.db          ← SQLite (chats + messages)
config.json        ← API key + provider settings
rag/
  index.json       ← RAG hash table index
  {chatId}.json    ← per-chat RAG chunks
hash/
  {chatId}.json    ← per-chat hash (disk backup)
```

## Usage

- **New chat** → `+` in sidebar
- **Switch API** → provider dropdown (Anthropic / OpenAI / Groq / Custom)
- **API key** → ⚙ Settings
- **Message window** → No history / Last 3 / Last 5 / Last 10 / All
- **Right-click selected text**:
  - Copy
  - Send to RAG → LLM formats → saved to RAG
  - Send to Hash → LLM extracts k/v → RAM + disk on flush
  - Pin to Context → always sent with every prompt
- **⬇ Hash** → flush RAM hash to disk

## vs Electron version

| | Electron | Tauri |
|---|---|---|
| Bundle size | ~150MB | ~8MB |
| RAM baseline | ~80MB | ~15MB |
| Startup time | ~2s | ~0.5s |
| Offline fonts | ✓ | ✓ |
