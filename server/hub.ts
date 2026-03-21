import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

export class UIHub {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private lastState: any = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });
    
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
      if (pathname === '/ws/ui') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws) => {
      console.log('[UI Hub] Client connected');
      this.clients.add(ws);
      
      // Send last state immediately
      if (this.lastState) {
        ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: this.lastState }));
      }

      ws.on('close', () => {
        console.log('[UI Hub] Client disconnected');
        this.clients.delete(ws);
      });

      ws.on('message', (message) => {
        try {
          const command = JSON.parse(message.toString());
          this.handleCommand(command, ws);
        } catch (e) {}
      });
    });
  }

  private handleCommand(command: any, ws: WebSocket) {
    // Commands from UI could be handled here or via REST API
    // For now, we prefer REST API for commands to keep it simple
  }

  broadcastState(state: any) {
    this.lastState = state;
    const message = JSON.stringify({ type: 'STATE_UPDATE', data: state });
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastLog(log: any) {
    const message = JSON.stringify({ type: 'LOG_UPDATE', data: log });
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}
