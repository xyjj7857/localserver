import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import axios from 'axios';
import { StrategyEngine } from "./server/strategyEngine";
import { StorageService } from "./server/storage";
import { SupabaseService } from "./server/supabase";
import { AppSettings } from "./src/shared/types";

let cachedIP: string | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

async function getPublicIP(): Promise<string> {
  const now = Date.now();
  if (cachedIP && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedIP;
  }

  const services = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
    'https://icanhazip.com/',
    'https://ident.me/',
    'https://checkip.amazonaws.com/'
  ];

  const fetchIP = async (url: string): Promise<string> => {
    const response = await axios.get(url, { timeout: 5000 });
    let ip = '';
    if (typeof response.data === 'string') {
      ip = response.data.trim();
    } else if (response.data && response.data.ip) {
      ip = response.data.ip;
    }
    
    if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
      return ip;
    }
    throw new Error('Invalid IP format');
  };

  try {
    const ip = await Promise.any(services.map(url => fetchIP(url)));
    cachedIP = ip;
    lastFetchTime = now;
    return ip;
  } catch (err) {
    console.error('所有公网IP获取服务均失败', err);
    return cachedIP || 'unknown';
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(express.json());

  // Strategy Engine Initialization
  let strategyEngine: StrategyEngine | null = null;
  let lastState: any = null;

  const broadcast = (data: any) => {
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const initStrategy = async () => {
    let settings = StorageService.getSettings();
    
    // Try to pull from Supabase on startup if configured
    if (settings && settings.supabase.projectUrl && settings.supabase.publishableKey) {
      console.log('[Supabase] Attempting to pull settings on startup...');
      const remoteSettings = await SupabaseService.pullSettings(settings);
      if (remoteSettings) {
        console.log('[Supabase] Settings pulled successfully on startup');
        settings = remoteSettings;
        StorageService.saveSettings(settings);
      }
    }

    if (settings) {
      strategyEngine = new StrategyEngine(settings, (state) => {
        lastState = state;
        broadcast({ type: 'UPDATE', state });
      });
      strategyEngine.start();
    }
  };

  initStrategy();

  // WebSocket Connection Handling
  wss.on('connection', (ws) => {
    console.log('[Server] Client connected to WebSocket');
    if (lastState) {
      ws.send(JSON.stringify({ type: 'UPDATE', state: lastState }));
    }

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG' }));
        }
      } catch (e) {}
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/ip", async (req, res) => {
    const ip = await getPublicIP();
    res.json({ ip });
  });

  app.get("/api/settings", (req, res) => {
    const settings = StorageService.getSettings();
    res.json(settings);
  });

  app.post("/api/settings", async (req, res) => {
    const settings = req.body as AppSettings;
    StorageService.saveSettings(settings);
    
    // Push to Supabase in background
    if (settings.supabase.projectUrl && settings.supabase.publishableKey) {
      SupabaseService.pushSettings(settings).catch(err => console.error('[Supabase] Background push failed:', err));
    }

    if (strategyEngine) {
      await strategyEngine.updateSettings(settings);
    } else {
      initStrategy();
    }
    res.json({ success: true });
  });

  app.post("/api/test-connection", async (req, res) => {
    const settings = req.body as AppSettings;
    try {
      const { BinanceService } = await import('./server/binance');
      const binance = new BinanceService(
        settings.binance.apiKey,
        settings.binance.secretKey,
        settings.binance.baseUrl
      );
      binance.setIpSelection(settings.ipSelection);
      await binance.getAccountInfo();
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/logs", (req, res) => {
    const logs = StorageService.getLogs();
    res.json(logs);
  });

  app.post("/api/master-switch", (req, res) => {
    const { value } = req.body;
    if (strategyEngine) {
      strategyEngine.setMasterSwitch(value);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Strategy engine not initialized' });
    }
  });

  app.post("/api/force-scan", (req, res) => {
    const { stage } = req.body;
    if (strategyEngine) {
      if (stage === 0) strategyEngine.forceRunStage0();
      else if (stage === '0P') strategyEngine.forceRunStage0P();
      else if (stage === 1) strategyEngine.forceRunStage1();
      else if (stage === 2) strategyEngine.forceRunStage2();
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Strategy engine not initialized' });
    }
  });

  app.post("/api/proxy", async (req, res) => {
    const { url, method, headers, body } = req.body;
    try {
      const cleanHeaders: Record<string, string> = {};
      if (headers) {
        Object.entries(headers).forEach(([key, val]) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey !== 'host' && lowerKey !== 'content-length' && typeof val === 'string') {
            cleanHeaders[key] = val;
          }
        });
      }
      const response = await axios({
        url,
        method,
        headers: cleanHeaders,
        data: body,
        timeout: 15000,
        validateStatus: () => true
      });
      res.status(response.status).json(response.data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server is listening on 0.0.0.0:${PORT}`);
    const ip = await getPublicIP();
    console.log('服务器公网 IP:', ip);
  });
}

startServer();
