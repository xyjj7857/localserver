import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import { AppSettings, LogEntry } from '../src/shared/types';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'strategy.db');

// Ensure data directory exists
if (!fs.existsSync(path.join(process.cwd(), 'data'))) {
  fs.mkdirSync(path.join(process.cwd(), 'data'));
}

const db = new Database(DB_PATH);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    module TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
`);

export class StorageService {
  static saveSettings(settings: AppSettings) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)');
    stmt.run(JSON.stringify(settings));
  }

  static getSettings(): AppSettings | null {
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (row) return JSON.parse(row.data);
    
    // Return default settings if none found
    return DEFAULT_SETTINGS;
  }

  static addLog(log: Omit<LogEntry, 'id' | 'timestamp'>) {
    const id = Math.random().toString(36).substring(2, 15);
    const timestamp = Date.now();
    const stmt = db.prepare('INSERT INTO logs (id, timestamp, type, module, message, details) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(id, timestamp, log.type, log.module, log.message, log.details ? JSON.stringify(log.details) : null);
    
    // Keep only last 1000 logs
    db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT 1000)').run();
  }

  static getLogs(): LogEntry[] {
    const rows = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 500').all() as any[];
    return rows.map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : undefined
    }));
  }

  static saveState(state: any) {
    const stmt = db.prepare('INSERT OR REPLACE INTO state (id, data) VALUES (1, ?)');
    stmt.run(JSON.stringify(state));
  }

  static getState(): any | null {
    const row = db.prepare('SELECT data FROM state WHERE id = 1').get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
}
