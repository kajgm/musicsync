// Live bus (WSS /api/live): sends the state on connect and whenever it changes, streams
// preview frames, and takes live control (master, start/stop) from signed-in clients.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ClientMessage, type LiveState, type ServerMessage } from '@musicsync/protocol';

export class Live {
  readonly state: LiveState;
  private readonly clients = new Set<WebSocket>();
  private queued = false;
  private readonly listeners: Array<(state: LiveState) => void> = [];

  constructor(app: FastifyInstance, initial: LiveState, onMessage: (msg: ClientMessage) => void) {
    this.state = initial;
    app.get('/api/live', { websocket: true }, (socket, req) => {
      // Browsers send cookies with cross-site WebSocket handshakes too, so check the origin.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        socket.close(4403, 'Cross-origin');
        return;
      }
      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('message', (data) => {
        let msg: ClientMessage;
        try {
          msg = ClientMessage.parse(JSON.parse(String(data)));
        } catch {
          return; // ignore anything malformed
        }
        onMessage(msg);
      });
      socket.send(JSON.stringify({ type: 'state', state: this.state } satisfies ServerMessage));
    });
  }

  /**
   * Merges top-level fields into the state; one broadcast per tick however many patches.
   * Change listeners run after it, and must only patch when something actually changes.
   */
  patch(update: Partial<LiveState>): void {
    Object.assign(this.state, update);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.broadcast({ type: 'state', state: this.state });
      for (const listener of this.listeners) listener(this.state);
    });
  }

  onChange(listener: (state: LiveState) => void): void {
    this.listeners.push(listener);
  }

  broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const client of this.clients) {
      // A client that can't keep up skips preview frames instead of buffering them. State goes
      // out only on change, so a client too far behind for it is closed instead: it reconnects
      // and gets the whole state then, rather than keeping a stale copy.
      if (client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount < 64 * 1024) client.send(text);
      else if (msg.type === 'state') client.terminate();
    }
  }
}
