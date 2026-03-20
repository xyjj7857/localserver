import express from "express";
import { createServer as createViteServer } from "vite";

import axios from 'axios';

async function getPublicIP(): Promise<string> {
  try {
    const res = await axios.get('https://api.ipify.org?format=json');
    return res.data.ip;
  } catch (err) {
    console.error('获取公网IP失败', err);
    return 'unknown';
  }
}

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
    const ip = await getPublicIP();
    console.log('[/api/ip] Server Public IP:', ip);
    res.json({ ip });
  });

  app.post("/api/proxy", async (req, res) => {
    const { url, method, headers, body } = req.body;
    try {
      // Clean up headers
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
        validateStatus: () => true // Allow any status code to be returned to client
      });
      
      res.status(response.status).json(response.data);
    } catch (e: any) {
      console.error(`[/api/proxy] Proxy error for ${url}:`, e.message);
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

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server is listening on 0.0.0.0:${PORT}`);
    console.log(`External access is available via the provided App URL.`);
    
    // 获取并打印公网 IP
    const ip = await getPublicIP();
    console.log('服务器公网 IP:', ip);
  });
}

startServer();
