import Database from 'better-sqlite3';
import { AppSettings, LogEntry } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/constants';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data.db');
const db = new Database(dbPath);

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    module TEXT,
    type TEXT,
    message TEXT,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
`);

export const BackendStorage = {
  getSettings(): AppSettings {
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as any;
    if (!row) return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(row.data);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        binance: { ...DEFAULT_SETTINGS.binance, ...(parsed.binance || {}) },
        supabase: { ...DEFAULT_SETTINGS.supabase, ...(parsed.supabase || {}) },
        scanner: { ...DEFAULT_SETTINGS.scanner, ...(parsed.scanner || {}) },
        order: { ...DEFAULT_SETTINGS.order, ...(parsed.order || {}) },
        email: { ...DEFAULT_SETTINGS.email, ...(parsed.email || {}) },
      };
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  },

  saveSettings(settings: AppSettings) {
    db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(settings));
  },

  getLogs(limit = 1000): LogEntry[] {
    const rows = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
    return rows.map(row => ({
      id: row.id,
      module: row.module,
      type: row.type,
      message: row.message,
      timestamp: row.timestamp
    }));
  },

  addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>) {
    const id = Math.random().toString(36).substring(2, 15);
    const timestamp = Date.now();
    db.prepare('INSERT INTO logs (id, module, type, message, timestamp) VALUES (?, ?, ?, ?, ?)').run(
      id, entry.module, entry.type, entry.message, timestamp
    );
    return { ...entry, id, timestamp };
  },

  clearLogs() {
    db.prepare('DELETE FROM logs').run();
  },

  saveState(state: any) {
    db.prepare('INSERT OR REPLACE INTO state (id, data) VALUES (1, ?)').run(JSON.stringify(state));
  },

  getState() {
    const row = db.prepare('SELECT data FROM state WHERE id = 1').get() as any;
    return row ? JSON.parse(row.data) : null;
  }
};
