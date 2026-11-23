// sensors module, Phase 1: the loopback agent connects over WSS /api/agent with its token,
// syncs its clock to ours and streams feature frames. Here they become the engine's audio
// signals: gain-controlled bass and level, plus kick onsets.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Agc, OnsetPicker, bassAmplitude } from '@musicsync/audio-features';
import { AgentMessage, type AgentFrame, type LiveState, type ServerToAgent } from '@musicsync/protocol';
import { now, type EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class SensorsModule {
  private readonly live: Live;
  private readonly engine: EngineHost;
  private readonly token: string;
  private current: { close(code: number, reason: string): void } | undefined;
  private frames = 0;

  constructor(app: FastifyInstance, store: Store, live: Live, engine: EngineHost) {
    this.live = live;
    this.engine = engine;
    let token: string | undefined;
    try {
      token = store.getSecret<string>('agentToken');
    } catch {
      // The master key changed: issue a new token.
    }
    if (!token) {
      token = randomBytes(32).toString('base64url');
      store.setSecret('agentToken', token);
    }
    this.token = token;

    app.get('/api/agent-token', async () => ({ token: this.token }));

    app.get('/api/agent', { websocket: true }, (socket) => {
      let signedIn = false;
      const kick = setTimeout(() => socket.close(4401, 'No hello'), 5000);
      const kicks = new OnsetPicker();
      const bassAgc = new Agc();
      const levelAgc = new Agc();
      const send = (msg: ServerToAgent) => socket.send(JSON.stringify(msg));

      socket.on('message', (data) => {
        let msg: AgentMessage;
        try {
          msg = AgentMessage.parse(JSON.parse(String(data)));
        } catch {
          socket.close(4400, 'Bad message');
          return;
        }
        if (!signedIn) {
          if (msg.type !== 'hello' || !timingSafeEqual(sha256(msg.token), sha256(this.token))) {
            socket.close(4401, 'Bad token');
            return;
          }
          signedIn = true;
          clearTimeout(kick);
          this.current?.close(4409, 'Another agent connected');
          this.current = socket;
          this.live.patch({ agent: { connected: true, device: msg.device, framesPerSec: 0 } });
          send({ type: 'welcome' });
        } else if (msg.type === 'ping') {
          send({ type: 'pong', t0: msg.t0, t: now() });
        } else if (msg.type === 'frame') {
          this.frame(msg, kicks.push(msg.lowFlux, msg.t) !== undefined, bassAgc, levelAgc);
        }
      });
      socket.on('close', () => {
        clearTimeout(kick);
        if (this.current !== socket) return;
        this.current = undefined;
        this.live.patch({ agent: { connected: false } });
      });
    });

    // Once a second: frame rate and mode.
    setInterval(() => {
      const agent = this.live.state.agent;
      const fps = this.frames;
      this.frames = 0;
      const spotify = this.live.state.spotify;
      const mode: LiveState['mode'] =
        agent.connected && fps > 10 && this.audioAllowed()
          ? 'full'
          : spotify.playing && spotify.device?.type !== 'Computer'
            ? 'spotify-only'
            : 'idle';
      if (agent.connected && agent.framesPerSec !== fps) this.live.patch({ agent: { ...agent, framesPerSec: fps } });
      if (mode !== this.live.state.mode) this.live.patch({ mode });
    }, 1000).unref();
  }

  /**
   * PC audio counts only while Spotify reports playing on a computer, so notification
   * sounds or videos can't drive the lights while the music is paused. Without a linked
   * Spotify account there is nothing to check against, so it always counts.
   */
  private audioAllowed(): boolean {
    const spotify = this.live.state.spotify;
    return !spotify.linked || (spotify.playing && spotify.device?.type === 'Computer');
  }

  private frame(f: AgentFrame, onset: boolean, bassAgc: Agc, levelAgc: Agc): void {
    this.frames++;
    const bass = bassAgc.push(bassAmplitude(f.bands), f.t);
    const level = levelAgc.push(f.rms, f.t);
    if (this.audioAllowed()) this.engine.send({ type: 'audio', t: f.t, level, bass, onset });
  }
}
