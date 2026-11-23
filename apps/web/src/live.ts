// The live bus connection (WSS /api/live), kept outside React. Components read it through
// useSyncExternalStore: the state for most of the UI, preview frames for the preview only.
import type { ClientMessage, LiveState, ServerMessage } from '@musicsync/protocol';

export type Snapshot = { state?: LiveState; connected: boolean };

export class LiveClient {
  snapshot: Snapshot = { connected: false };
  colors: string[] = [];
  private ws: WebSocket | undefined;
  private closed = false;
  private retryMs = 1000;
  private readonly stateListeners = new Set<() => void>();
  private readonly frameListeners = new Set<() => void>();
  private readonly onSignedOut: () => void;

  constructor(onSignedOut: () => void) {
    this.onSignedOut = onSignedOut;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.setSnapshot({ connected: true });
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg.type === 'state') {
        this.setSnapshot({ state: msg.state });
      } else {
        this.colors = msg.colors;
        for (const listener of this.frameListeners) listener();
      }
    };
    ws.onclose = async () => {
      this.setSnapshot({ connected: false });
      if (this.closed) return;
      // A refused upgrade looks like any other drop, so check whether the session ended.
      const session = await fetch('/api/session')
        .then((r) => r.json() as Promise<{ signedIn: boolean }>)
        .catch(() => undefined);
      if (session && !session.signedIn) {
        this.onSignedOut();
        return;
      }
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  private setSnapshot(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.stateListeners) listener();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  subscribeFrames = (listener: () => void) => {
    this.frameListeners.add(listener);
    return () => void this.frameListeners.delete(listener);
  };
  getColors = () => this.colors;
}
