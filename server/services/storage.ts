import Database from 'better-sqlite3';
import { AppSettings, LogEntry } from '../types';
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
    const defaultSettings: AppSettings = {
      binance: {
        apiKey: '',
        secretKey: '',
        baseUrl: 'https://fapi.binance.com',
        wsUrl: 'wss://fstream.binance.com/ws'
      },
      supabase: {
        projectUrl: '',
        publishableKey: '',
        connectionString: '',
        supaName: 'strategy_settings'
      },
      scanner: {
        stage0Period: '1h',
        stage0StartTime: '00:35',
        stage0KLineInterval: '15m',
        stage0KCountMin: 10,
        stage0KCountMax: 100,
        stage0CustomMinutes: 15,
        stage0PEnabled: true,
        stage0PPeriod: '1h',
        stage0PStartTime: '00:35',
        stage0P15mEnabled: true,
        stage0P15mCount: 4,
        stage0P15mRef: 0,
        stage0P1hEnabled: true,
        stage0P1hCount: 1,
        stage0P1hRef: 0,
        stage0P4hEnabled: true,
        stage0P4hCount: 1,
        stage0P4hRef: 0,
        stage0PDayEnabled: true,
        stage0PDayCount: 1,
        stage0PDayRef: 0,
        stage0PParam1Enabled: false,
        stage0PParam1Ref: 0,
        stage0PParam2Enabled: false,
        stage0PParam2Ref: 0,
        stage0PParam3Enabled: false,
        stage0PParam3Ref: 0,
        stage1Period: '15m',
        stage1StartTime: '00:14:30.000',
        stage1MinVolume: 1000000,
        stage1KLineMin: 10,
        stage1KLineMax: 100,
        whitelist: '',
        blacklist: '',
        stage1Cond1Enabled: true,
        stage1Cond2Enabled: true,
        stage2K21: 0,
        stage2K22: 0,
        stage2A21: 0,
        stage2A22: 0,
        stage2M21: 0,
        stage2M22: 0,
        stage2K51: 0,
        stage2K52: 0,
        stage2KB1: 0,
        stage2KB2: 0,
        stage2Period: '15m',
        stage2StartTime: '00:14:57.000',
        stage2Cooldown: 60,
        stage2Cond1Enabled: true,
        stage2Cond2Enabled: true,
        stage2Cond3Enabled: true,
        stage2Cond4Enabled: true,
        stage2Cond5Enabled: true,
      },
      order: {
        leverage: 10,
        positionRatio: 0.1,
        maxPositionAmount: 100,
        takeProfitRatio: 0.02,
        stopLossRatio: 0.01,
        forwardOrderWindow: 5,
        maxHoldTime: 3600,
        period: '15m',
        startTime: '00:14:59.500',
        kClosedPeriod: '15m',
        kClosedWindowStart: 1,
        kClosedWindowEnd: 4,
      },
      masterSwitch: false,
      ipSelection: 'local',
      email: {
        enabled: false,
        from: '',
        to: '',
        smtp: '',
        port: 465,
        pass: '',
        balanceLimitEnabled: false,
        balanceLimit: 100,
        reverseOrderLimitEnabled: false,
        reverseOrderLimit: 3
      }
    };
    return defaultSettings;
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
