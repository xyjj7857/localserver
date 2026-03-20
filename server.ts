import express from "express";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/test", (req, res) => {
    console.log('Test endpoint hit');
    res.json({ message: "Backend is reachable", time: new Date().toISOString() });
  });

  app.get("/api/ip", async (req, res) => {
    console.log('[/api/ip] Fetching server IP...');
    const services = [
      'https://api.ipify.org?format=json',
      'http://api.ipify.org?format=json',
      'https://api64.ipify.org?format=json',
      'http://api64.ipify.org?format=json',
      'https://ifconfig.me/all.json',
      'https://ipapi.co/json/',
      'https://api.myip.com'
    ];

    for (const service of services) {
      try {
        console.log(`[/api/ip] Trying IP service: ${service}`);
        const response = await fetch(service, {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(10000)
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log(`[/api/ip] Raw data from ${service}:`, data);
          const ip = data.ip || data.ip_addr || data.query || data.ip_address;
          if (ip) {
            console.log(`[/api/ip] Successfully fetched IP: ${ip} from ${service}`);
            return res.json({ ip });
          }
        } else {
          console.error(`[/api/ip] Service ${service} returned status: ${response.status}`);
        }
      } catch (e: any) {
        console.error(`[/api/ip] Failed to fetch IP from ${service}: ${e.message}`);
      }
    }

    console.error('[/api/ip] All IP services failed');
    res.status(500).json({ error: 'Failed to fetch IP from all services' });
  });

  app.post("/api/proxy", async (req, res) => {
    const { url, method, headers, body } = req.body;
    try {
      // Clean up headers to avoid issues with host or other restricted headers
      const cleanHeaders: Record<string, string> = {};
      if (headers) {
        Object.entries(headers).forEach(([key, val]) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey !== 'host' && lowerKey !== 'content-length' && typeof val === 'string') {
            cleanHeaders[key] = val;
          }
        });
      }

      const response = await fetch(url, {
        method,
        headers: cleanHeaders,
        body: method !== 'GET' && body ? JSON.stringify(body) : undefined
      });
      
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        res.status(response.status).json(data);
      } else {
        const text = await response.text();
        res.status(response.status).json({ error: `Non-JSON response from Binance (${response.status})`, details: text.slice(0, 500) });
      }
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
        secure: port === 465, // true for 465, false for other ports
        auth: {
          user: from,
          pass: pass,
        },
      });

      const info = await transporter.sendMail({
        from: from,
        to: to,
        subject: subject,
        text: text,
      });

      res.json({ success: true, messageId: info.messageId });
    } catch (e: any) {
      console.error('Email Error:', e);
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
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile("dist/index.html", { root: "." });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is listening on 0.0.0.0:${PORT}`);
    console.log(`External access is available via the provided App URL.`);
  });
}

startServer();
