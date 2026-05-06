use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

// ── State ─────────────────────────────────────────────────

/// Per-chat RAM hash: chatId -> key -> value
struct HashStore(Mutex<HashMap<String, HashMap<String, serde_json::Value>>>);

/// SQLite connection
struct Db(Mutex<Connection>);

// ── Data paths ────────────────────────────────────────────

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir()
        .expect("Failed to resolve app data directory")
        .join("llm-terminal")
}

fn rag_dir(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("rag")
}

fn hash_dir(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("hash")
}

fn rag_index_path(app: &tauri::AppHandle) -> PathBuf {
    rag_dir(app).join("index.json")
}

fn rag_path(app: &tauri::AppHandle, chat_id: &str) -> PathBuf {
    rag_dir(app).join(format!("{}.json", chat_id))
}

fn hash_path(app: &tauri::AppHandle, chat_id: &str) -> PathBuf {
    hash_dir(app).join(format!("{}.json", chat_id))
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("config.json")
}

// ── Structs ───────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct Chat {
    id: String,
    title: String,
    created_at: i64,
    api_provider: Option<String>,
    api_model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Message {
    id: i64,
    chat_id: String,
    role: String,
    content: String,
    timestamp: i64,
    pinned: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct RagChunk {
    id: i64,
    content: String,
    added: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    provider: String,
    model: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            provider: "anthropic".into(),
            model: "claude-opus-4-5-20251001".into(),
            api_key: String::new(),
            base_url: String::new(),
        }
    }
}

// ── Config commands ───────────────────────────────────────

#[tauri::command]
fn config_load(app: tauri::AppHandle) -> Config {
    let p = config_path(&app);
    if !p.exists() { return Config::default(); }
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return Config::default(),
    };
    let mut cfg: Config = serde_json::from_str(&raw).unwrap_or_default();
    // Ensure defaults for missing fields
    if cfg.provider.is_empty() { cfg.provider = "anthropic".into(); }
    if cfg.model.is_empty() { cfg.model = "claude-opus-4-5-20251001".into(); }
    cfg
}

#[tauri::command]
fn config_save(app: tauri::AppHandle, cfg: Config) -> bool {
    let p = config_path(&app);
    let json = serde_json::to_string_pretty(&cfg).unwrap_or_default();
    fs::write(p, json).is_ok()
}

// ── Chat commands ─────────────────────────────────────────

#[tauri::command]
fn chats_list(db: State<Db>) -> Vec<Chat> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, api_provider, api_model FROM chats ORDER BY created_at DESC"
    ).unwrap();
    stmt.query_map([], |row| {
        Ok(Chat {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            api_provider: row.get(3)?,
            api_model: row.get(4)?,
        })
    }).unwrap().filter_map(|r| r.ok()).collect()
}

#[tauri::command]
fn chats_create(db: State<Db>, id: String, title: String, provider: String, model: String) -> String {
    let conn = db.0.lock().unwrap();
    let now = chrono_millis();
    conn.execute(
        "INSERT INTO chats (id, title, created_at, api_provider, api_model) VALUES (?1,?2,?3,?4,?5)",
        params![id, title, now, provider, model],
    ).unwrap();
    id
}

#[tauri::command]
fn chats_delete(app: tauri::AppHandle, db: State<Db>, hash_store: State<HashStore>, chat_id: String) -> bool {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM chats WHERE id=?1", params![chat_id]).unwrap();
    conn.execute("DELETE FROM messages WHERE chat_id=?1", params![chat_id]).unwrap();
    drop(conn); // explicitly release Db lock before acquiring HashStore lock — prevents potential deadlock

    let rp = rag_path(&app, &chat_id);
    if rp.exists() { let _ = fs::remove_file(&rp); }

    // Update RAG index
    let idx_path = rag_index_path(&app);
    if idx_path.exists() {
        if let Ok(raw) = fs::read_to_string(&idx_path) {
            if let Ok(mut idx) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(map) = idx.as_object_mut() {
                    map.remove(&chat_id);
                    let _ = fs::write(&idx_path, serde_json::to_string_pretty(&idx).unwrap());
                }
            }
        }
    }

    hash_store.0.lock().unwrap().remove(&chat_id);
    let hp = hash_path(&app, &chat_id);
    if hp.exists() { let _ = fs::remove_file(&hp); }

    true
}

// ── Message commands ──────────────────────────────────────

#[tauri::command]
fn messages_get(db: State<Db>, chat_id: String) -> Vec<Message> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, content, timestamp, pinned FROM messages WHERE chat_id=?1 ORDER BY timestamp ASC"
    ).unwrap();
    stmt.query_map(params![chat_id], |row| {
        Ok(Message {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            timestamp: row.get(4)?,
            pinned: row.get(5)?,
        })
    }).unwrap().filter_map(|r| r.ok()).collect()
}

#[tauri::command]
fn messages_add(db: State<Db>, chat_id: String, role: String, content: String) -> i64 {
    let conn = db.0.lock().unwrap();
    let now = chrono_millis();
    conn.execute(
        "INSERT INTO messages (chat_id, role, content, timestamp, pinned) VALUES (?1,?2,?3,?4,0)",
        params![chat_id, role, content, now],
    ).unwrap();
    conn.last_insert_rowid()
}

#[tauri::command]
fn messages_pin(db: State<Db>, chat_id: String, msg_id: i64) -> bool {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE messages SET pinned=1 WHERE id=?1 AND chat_id=?2", params![msg_id, chat_id]).unwrap();
    true
}

#[tauri::command]
fn messages_unpin(db: State<Db>, chat_id: String, msg_id: i64) -> bool {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE messages SET pinned=0 WHERE id=?1 AND chat_id=?2", params![msg_id, chat_id]).unwrap();
    true
}

#[tauri::command]
fn messages_get_pinned(db: State<Db>, chat_id: String) -> Vec<Message> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, content, timestamp, pinned FROM messages WHERE chat_id=?1 AND pinned=1 ORDER BY timestamp ASC"
    ).unwrap();
    stmt.query_map(params![chat_id], |row| {
        Ok(Message {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            timestamp: row.get(4)?,
            pinned: row.get(5)?,
        })
    }).unwrap().filter_map(|r| r.ok()).collect()
}

#[tauri::command]
fn messages_get_window(db: State<Db>, chat_id: String, n: i64) -> Vec<Message> {
    if n <= 0 { return vec![]; }
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, content, timestamp, pinned FROM (SELECT * FROM messages WHERE chat_id=?1 ORDER BY timestamp DESC LIMIT ?2) ORDER BY timestamp ASC"
    ).unwrap();
    stmt.query_map(params![chat_id, n], |row| {
        Ok(Message {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            timestamp: row.get(4)?,
            pinned: row.get(5)?,
        })
    }).unwrap().filter_map(|r| r.ok()).collect()
}

// ── Combined context load (single IPC call for hash + RAG) ───
#[tauri::command]
fn context_load_parallel(
    app: tauri::AppHandle,
    hash_store: State<HashStore>,
    chat_id: String,
    query: String,  // user's current message for RAG relevance filtering
) -> (HashMap<String, serde_json::Value>, String) {
    // Hash: reload from file into RAM
    let hash_result: HashMap<String, serde_json::Value> = {
        let p = hash_path(&app, &chat_id);
        if p.exists() {
            fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        }
    };

    // RAG: read chunks, filter by keyword relevance to query
    let rag_result: String = {
        let p = rag_path(&app, &chat_id);
        if p.exists() {
            let chunks: Vec<RagChunk> = fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            // Build query keyword set (lowercase, 3+ chars, skip common words)
            let stopwords = ["the","and","for","that","this","with","from","are","was",
                             "what","how","why","who","when","where","is","it","in",
                             "of","to","a","an","do","you","my","me","can","be","have"];
            let query_words: std::collections::HashSet<String> = query
                .to_lowercase()
                .split(|c: char| !c.is_alphabetic())
                .filter(|w| w.len() >= 3 && !stopwords.contains(w))
                .map(|w| w.to_string())
                .collect();

            // Only inject chunks that share at least one keyword with the query
            let relevant: Vec<&str> = chunks.iter()
                .filter(|chunk| {
                    if query_words.is_empty() { return false; }
                    let chunk_lower = chunk.content.to_lowercase();
                    query_words.iter().any(|w| chunk_lower.contains(w.as_str()))
                })
                .map(|c| c.content.as_str())
                .collect();

            relevant.join("\n\n")
        } else {
            String::new()
        }
    };

    // Update RAM hash store
    hash_store.0.lock().unwrap()
        .entry(chat_id)
        .or_default()
        .extend(hash_result.clone());

    (hash_result, rag_result)
}

// ── RAG commands ──────────────────────────────────────────

#[tauri::command]
fn rag_load(app: tauri::AppHandle, chat_id: String) -> Vec<RagChunk> {
    let p = rag_path(&app, &chat_id);
    if !p.exists() { return vec![]; }
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

#[tauri::command]
fn rag_add(app: tauri::AppHandle, chat_id: String, chunk: String) -> usize {
    let p = rag_path(&app, &chat_id);
    let mut chunks: Vec<RagChunk> = if p.exists() {
        fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    let now = chrono_millis();
    chunks.push(RagChunk { id: now, content: chunk, added: now });
    let json = serde_json::to_string_pretty(&chunks).unwrap();
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, &json).unwrap();

    // Update index
    let idx_path = rag_index_path(&app);
    let mut idx: serde_json::Value = if idx_path.exists() {
        fs::read_to_string(&idx_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if let Some(map) = idx.as_object_mut() {
        map.insert(chat_id, serde_json::json!({
            "path": p.to_string_lossy(),
            "count": chunks.len(),
            "updated": now
        }));
    }
    fs::write(&idx_path, serde_json::to_string_pretty(&idx).unwrap()).unwrap();
    chunks.len()
}

#[tauri::command]
fn rag_get_context(app: tauri::AppHandle, chat_id: String) -> String {
    let p = rag_path(&app, &chat_id);
    if !p.exists() { return String::new(); }
    let chunks: Vec<RagChunk> = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    chunks.iter().map(|c| c.content.clone()).collect::<Vec<_>>().join("\n\n")
}

// ── Hash commands ─────────────────────────────────────────

#[tauri::command]
fn hash_get(hash_store: State<HashStore>, chat_id: String) -> HashMap<String, serde_json::Value> {
    hash_store.0.lock().unwrap()
        .get(&chat_id)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
fn hash_set(hash_store: State<HashStore>, chat_id: String, key: String, value: serde_json::Value) -> bool {
    hash_store.0.lock().unwrap()
        .entry(chat_id)
        .or_default()
        .insert(key, value);
    true
}

#[tauri::command]
fn hash_delete(hash_store: State<HashStore>, chat_id: String, key: String) -> bool {
    hash_store.0.lock().unwrap()
        .entry(chat_id)
        .or_default()
        .remove(&key);
    true
}

#[tauri::command]
fn rag_save(app: tauri::AppHandle, chat_id: String, chunks: Vec<RagChunk>) -> bool {
    let p = rag_path(&app, &chat_id);
    let json = match serde_json::to_string_pretty(&chunks) {
        Ok(j) => j,
        Err(_) => return false,
    };
    if fs::write(&p, &json).is_err() { return false; }
    // Update index
    let idx_path = rag_index_path(&app);
    let mut idx: serde_json::Value = if idx_path.exists() {
        fs::read_to_string(&idx_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if let Some(map) = idx.as_object_mut() {
        map.insert(chat_id, serde_json::json!({
            "path": p.to_string_lossy(),
            "count": chunks.len(),
            "updated": chrono_millis()
        }));
    }
    fs::write(&idx_path, serde_json::to_string_pretty(&idx).unwrap()).is_ok()
}

#[tauri::command]
fn hash_add_entry(hash_store: State<HashStore>, chat_id: String, entry: HashMap<String, serde_json::Value>) -> HashMap<String, serde_json::Value> {
    let mut store = hash_store.0.lock().unwrap();
    let chat_hash = store.entry(chat_id).or_default();
    for (k, v) in entry {
        chat_hash.insert(k, v);
    }
    chat_hash.clone()
}

#[tauri::command]
fn hash_flush(app: tauri::AppHandle, hash_store: State<HashStore>, chat_id: String) -> bool {
    let store = hash_store.0.lock().unwrap();
    let obj = store.get(&chat_id).cloned().unwrap_or_default();
    let p = hash_path(&app, &chat_id);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    let json = serde_json::to_string_pretty(&obj).unwrap();
    fs::write(p, json).is_ok()
}

#[tauri::command]
fn hash_load_from_file(app: tauri::AppHandle, hash_store: State<HashStore>, chat_id: String) -> HashMap<String, serde_json::Value> {
    let p = hash_path(&app, &chat_id);
    if !p.exists() { return HashMap::new(); }
    let obj: HashMap<String, serde_json::Value> = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    hash_store.0.lock().unwrap()
        .entry(chat_id)
        .or_default()
        .extend(obj.clone());
    obj
}

// ── Helpers ───────────────────────────────────────────────

fn chrono_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── App entry point ───────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Create data dirs
            let data = app.path().app_data_dir()
                .expect("Failed to resolve app data directory")
                .join("llm-terminal");
            fs::create_dir_all(data.join("rag")).unwrap();
            fs::create_dir_all(data.join("hash")).unwrap();

            // Init SQLite
            let db_path = data.join("master.db");
            let conn = Connection::open(&db_path).expect("Failed to open database");
            conn.execute_batch("
                CREATE TABLE IF NOT EXISTS chats (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    created_at INTEGER,
                    api_provider TEXT,
                    api_model TEXT
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT,
                    role TEXT,
                    content TEXT,
                    timestamp INTEGER,
                    pinned INTEGER DEFAULT 0
                );
                PRAGMA journal_mode=WAL;
            ").expect("Failed to init database");

            app.manage(Db(Mutex::new(conn)));
            app.manage(HashStore(Mutex::new(HashMap::new())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_load,
            config_save,
            chats_list,
            chats_create,
            chats_delete,
            messages_get,
            messages_add,
            messages_pin,
            messages_unpin,
            messages_get_pinned,
            messages_get_window,
            rag_load,
            rag_add,
            rag_save,
            rag_get_context,
            hash_get,
            hash_set,
            hash_delete,
            hash_add_entry,
            hash_flush,
            hash_load_from_file,
            context_load_parallel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
