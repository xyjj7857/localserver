import WebSocket from 'ws';

export class BinanceWS {
  private ws: WebSocket | null = null;
  private url: string;
  private listenKey: string | null = null;
  private onMessage: (data: any) => void;
  private onOpen?: () => void;
  private onClose?: () => void;
  private onError?: (err: any) => void;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 100;
  private initialReconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private subscriptions: Set<string> = new Set();

  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong: number = Date.now();
  private isManualClose: boolean = false;

  constructor(url: string, onMessage: (data: any) => void) {
    this.url = url;
    this.onMessage = onMessage;
  }

  setUrl(url: string) {
    if (this.url !== url) {
      this.url = url;
      if (this.ws) {
        this.isManualClose = false;
        this.ws.close();
      }
    }
  }

  setListenKey(key: string | null) {
    if (this.listenKey !== key) {
      this.listenKey = key;
      if (this.ws) {
        this.isManualClose = false;
        this.ws.close();
      }
    }
  }

  connect(onOpen?: () => void, onClose?: () => void, onError?: (err: any) => void) {
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onError = onError;
    this.isManualClose = false;

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    let baseUrl = this.url.endsWith('/') ? this.url.slice(0, -1) : this.url;
    let fullUrl = baseUrl;
    
    if (this.listenKey) {
      fullUrl = `${baseUrl}/${this.listenKey}`;
    }

    console.log(`[Server] Connecting to Binance WebSocket (Attempt ${this.reconnectAttempts + 1}):`, fullUrl);
    try {
      this.ws = new WebSocket(fullUrl);
    } catch (e) {
      console.error('[Server] WebSocket Creation Failed:', e);
      if (this.onError) this.onError(e);
      this.scheduleReconnect();
      return;
    }

    const connectionTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        console.warn('[Server] WebSocket connection timeout, retrying...');
        this.ws.close();
      }
    }, 15000);

    this.ws.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log('[Server] Binance WebSocket Connected');
      this.reconnectAttempts = 0;
      this.lastPong = Date.now();
      this.startHeartbeat();
      if (this.onOpen) this.onOpen();
      this.resubscribe();
    });

    this.ws.on('message', (data) => {
      this.lastPong = Date.now();
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.e === 'ping') {
          this.ws?.send(JSON.stringify({ method: 'pong' }));
          return;
        }
        this.onMessage(parsed);
      } catch (e) {}
    });

    this.ws.on('close', (code, reason) => {
      clearTimeout(connectionTimeout);
      console.log(`[Server] Binance WebSocket Closed. Code: ${code}, Reason: ${reason}`);
      this.stopHeartbeat();
      if (this.onClose) this.onClose();
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Server] Binance WebSocket Error:', err);
      if (this.onError) this.onError(err);
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const idleTime = Date.now() - this.lastPong;
        if (idleTime > 60000) {
          console.warn(`[Server] Binance WebSocket Idle Timeout (${Math.floor(idleTime/1000)}s), reconnecting...`);
          this.ws.close();
          return;
        }
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isManualClose) return;
    
    let delay;
    if (this.reconnectAttempts < 5) {
      delay = this.initialReconnectDelay;
    } else {
      delay = Math.min(Math.pow(2, this.reconnectAttempts - 5) * 2000, this.maxReconnectDelay);
    }
    
    console.log(`[Server] Scheduling Binance WebSocket reconnect in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect(this.onOpen, this.onClose, this.onError);
    }, delay);
  }

  subscribe(streams: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      streams.forEach(s => this.subscriptions.add(s));
      return;
    }

    const payload = {
      method: 'SUBSCRIBE',
      params: streams,
      id: Date.now(),
    };
    this.ws.send(JSON.stringify(payload));
    streams.forEach(s => this.subscriptions.add(s));
  }

  unsubscribe(streams: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      streams.forEach(s => this.subscriptions.delete(s));
      return;
    }

    const payload = {
      method: 'UNSUBSCRIBE',
      params: streams,
      id: Date.now(),
    };
    this.ws.send(JSON.stringify(payload));
    streams.forEach(s => this.subscriptions.delete(s));
  }

  private resubscribe() {
    if (this.subscriptions.size > 0) {
      this.subscribe(Array.from(this.subscriptions));
    }
  }

  close() {
    this.isManualClose = true;
    if (this.ws) {
      this.ws.close();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }

  get status() {
    if (!this.ws) return 'CLOSED';
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }
}
