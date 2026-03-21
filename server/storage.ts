import Database from 'better-sqlite3';
import { AppSettings, LogEntry } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/constants';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbPath)) {
  fs.mkdirSync(dbPath);
}

const db = new Database(path.join(dbPath, 'database.sqlite'));

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    module TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
`);

export const StorageService = {
  getSettings(): AppSettings {
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as any;
    if (!row) return DEFAULT_SETTINGS;
    try {
      return JSON.parse(row.data);
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  },

  saveSettings(settings: AppSettings) {
    db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(settings));
  },

  getLogs(): LogEntry[] {
    const rows = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 1000').all() as any[];
    return rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      module: row.module,
      type: row.type as any,
      message: row.message
    }));
  },

  addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): LogEntry {
    const newLog: LogEntry = {
      ...entry,
      id: Math.random().toString(36).substring(2, 15),
      timestamp: Date.now(),
    };
    db.prepare('INSERT INTO logs (id, timestamp, module, type, message) VALUES (?, ?, ?, ?, ?)')
      .run(newLog.id, newLog.timestamp, newLog.module, newLog.type, newLog.message);
    return newLog;
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
