import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import http from "http";
import { BackendStorage } from "./server/storage";
import { UIHub } from "./server/hub";
import { BackendStrategyEngine } from "./server/strategy";
import { SupabaseService } from "./src/services/supabase";
import { DEFAULT_SETTINGS } from "./src/constants";
import { AppSettings } from "./src/types";

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
  const PORT = 3000;

  app.use(express.json());

  // Create HTTP server for WebSocket support
  const httpServer = http.createServer(app);

  // Initialize UI Hub
  const uiHub = new UIHub(httpServer);

  // Load initial settings
  let settings = BackendStorage.getSettings() || DEFAULT_SETTINGS;

  // Initialize Strategy Engine
  const engine = new BackendStrategyEngine(
    settings,
    (state) => uiHub.broadcastState(state),
    (log) => uiHub.broadcastLog(log)
  );

  // Automatic Startup Logic
  const autoStart = async () => {
    console.log('[Server] Starting automatic initialization...');
    try {
      // 1. Try to pull settings from Supabase
      const remoteSettings = await SupabaseService.pullSettings(settings);
      if (remoteSettings) {
        console.log('[Server] Successfully pulled settings from Supabase');
        settings = remoteSettings;
        BackendStorage.saveSettings(settings);
        engine.updateSettings(settings);
      } else {
        console.log('[Server] No settings found in Supabase or pull failed, using local settings');
      }

      // 2. Start the engine
      await engine.start();
      
      // 3. Automatically enable Master Switch
      console.log('[Server] Automatically enabling Master Switch...');
      engine.setMasterSwitch(true);
      
    } catch (error) {
      console.error('[Server] Auto-start error:', error);
      await engine.start();
    }
  };

  autoStart();

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", version: "1.2.0" });
  });

  app.get("/api/ip", async (req, res) => {
    const ip = await getPublicIP();
    res.json({ ip });
  });

  app.get("/api/state", (req, res) => {
    res.json(engine.getFullState());
  });

  app.get("/api/settings", (req, res) => {
    res.json(BackendStorage.getSettings() || DEFAULT_SETTINGS);
  });

  app.post("/api/settings", (req, res) => {
    const newSettings = req.body as AppSettings;
    BackendStorage.saveSettings(newSettings);
    engine.updateSettings(newSettings);
    res.json({ success: true });
  });

  app.post("/api/master-switch", (req, res) => {
    const { enabled } = req.body;
    engine.setMasterSwitch(enabled);
    res.json({ success: true, enabled });
  });

  app.post("/api/force-scan", async (req, res) => {
    const { stage } = req.body;
    try {
      if (stage === 0) (engine as any).runStage0();
      if (stage === '0P') (engine as any).runStage0P();
      if (stage === 1) (engine as any).runStage1();
      if (stage === 2) (engine as any).runStage2();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/logs", (req, res) => {
    res.json(BackendStorage.getLogs());
  });

  app.delete("/api/logs", (req, res) => {
    BackendStorage.clearLogs();
    res.json({ success: true });
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

  app.post("/api/send-email", async (req, res) => {
    const { from, to, smtp, port, pass, subject, text } = req.body;
    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtp,
        port: port,
        secure: port === 465,
        auth: { user: from, pass: pass },
      });

      await transporter.sendMail({ from, to, subject, text });
      res.json({ success: true });
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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is listening on 0.0.0.0:${PORT}`);
  });
}

startServer();
