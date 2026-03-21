import { AppSettings, LogEntry } from "../shared/types";

export class StrategyClient {
  private ws: WebSocket | null = null;
  private onUpdate: (state: any) => void;
  private reconnectTimer: any = null;
  private isManualClose: boolean = false;

  constructor(onUpdate: (state: any) => void) {
    this.onUpdate = onUpdate;
  }

  connect() {
    this.isManualClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}`;

    console.log('[Client] Connecting to Server WebSocket:', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[Client] Server WebSocket Connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'UPDATE') {
          this.onUpdate(data.state);
        }
      } catch (e) {}
    };

    this.ws.onclose = () => {
      console.log('[Client] Server WebSocket Closed');
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[Client] Server WebSocket Error:', err);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  async updateSettings(settings: AppSettings) {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return response.json();
  }

  async setMasterSwitch(value: boolean) {
    const response = await fetch('/api/master-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    return response.json();
  }

  async forceScan(stage: any) {
    const response = await fetch('/api/force-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    return response.json();
  }

  async getLogs(): Promise<LogEntry[]> {
    const response = await fetch('/api/logs');
    return response.json();
  }

  async getSettings(): Promise<AppSettings | null> {
    const response = await fetch('/api/settings');
    return response.json();
  }

  close() {
    this.isManualClose = true;
    if (this.ws) this.ws.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }
}
