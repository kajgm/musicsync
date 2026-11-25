import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { stageFixtures, type LiveState, type Rule } from '@musicsync/protocol';
import { LooksPage, REASONS, css, saveLibrary } from './Looks.tsx';
import { LayoutPage, PlanPreview } from './Layout.tsx';
import { LiveClient } from './live.ts';

async function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, string> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  return { ok: res.ok, status: res.status, data };
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const signOut = useCallback(() => setSignedIn(false), []);
  useEffect(() => {
    fetch('/api/session')
      .then((r) => r.json() as Promise<{ signedIn: boolean }>)
      .then((s) => setSignedIn(s.signedIn))
      .catch(() => setSignedIn(false));
  }, []);
  if (signedIn === undefined) return null;
  return signedIn ? <Main onSignedOut={signOut} /> : <Login onSignedIn={() => setSignedIn(true)} />;
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await post('/api/login', { password }).catch(() => undefined);
    setBusy(false);
    if (res?.ok) onSignedIn();
    else setError(res?.data.error ?? 'Can’t reach the server');
  }
  return (
    <main className="login">
      <h1>musicsync</h1>
      <form className="card" onSubmit={submit}>
        <label className="stack">
          Household password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="primary" disabled={busy}>
          Sign in
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

type Page = 'live' | 'looks' | 'layout' | 'setup';
const PAGES: Record<Page, string> = { live: 'Live', looks: 'Looks', layout: 'Layout', setup: 'Setup' };

function usePage(): Page {
  const read = (): Page => {
    const hash = location.hash.slice(1);
    return hash in PAGES ? (hash as Page) : 'live';
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return page;
}

function Main({ onSignedOut }: { onSignedOut: () => void }) {
  const [client, setClient] = useState<LiveClient>();
  useEffect(() => {
    const c = new LiveClient(onSignedOut);
    setClient(c);
    return () => c.close();
  }, [onSignedOut]);
  const page = usePage();
  return (
    <div className="app">
      <header>
        <span className="brand">musicsync</span>
        <nav>
          {(Object.keys(PAGES) as Page[]).map((p) => (
            <a key={p} href={`#${p}`} aria-current={page === p ? 'page' : undefined}>
              {PAGES[p]}
            </a>
          ))}
        </nav>
      </header>
      {client && <Pages client={client} page={page} onSignedOut={onSignedOut} />}
    </div>
  );
}

function Pages({ client, page, onSignedOut }: { client: LiveClient; page: Page; onSignedOut: () => void }) {
  const { state, connected } = useSyncExternalStore(client.subscribeState, client.getSnapshot);
  return (
    <>
      {!connected && <p className="banner">Connecting to the server…</p>}
      {state && page === 'setup' && <Setup state={state} onSignedOut={onSignedOut} />}
      {state && page === 'layout' && <LayoutPage state={state} client={client} />}
      {state && page === 'looks' && <LooksPage state={state} client={client} />}
      {state && page === 'live' && <Live state={state} client={client} />}
    </>
  );
}

// ---- Live ----

const MODE_TEXT: Record<LiveState['mode'], string> = {
  full: 'Following the PC’s audio',
  'spotify-only': 'Spotify-only: no live audio from this device yet',
  idle: 'Waiting for music',
};

function outputText(state: LiveState): string {
  const { output, hue } = state;
  switch (output.status) {
    case 'no-bridge':
      return 'Preview only: pair the Hue bridge in Setup.';
    case 'off':
      return `Lights off. ${hue.lights.length} lights ready.`;
    case 'connecting':
      return 'Connecting to the bridge…';
    case 'streaming':
      return `Streaming to ${hue.lights.length} lights at ${output.fps || 50} fps.`;
    case 'error':
      return `Light stream problem: ${output.error ?? 'unknown'}. Retrying…`;
  }
}

/** The playing look, why it plays, and rules from what's playing now. */
function LookPicker({ state, client }: { state: LiveState; client: LiveClient }) {
  const { library, program, spotify } = state;
  const [message, setMessage] = useState<string>();
  const track = spotify.track;
  const playlist = spotify.context?.type === 'playlist' ? spotify.context : undefined;
  const artist = track?.artistList[0];
  async function addRule(kind: Rule['kind'], uri: string, label: string) {
    const rules = [...library.rules.filter((r) => !(r.kind === kind && r.uri === uri)), { id: Math.random().toString(36).slice(2, 10), kind, uri, label, lookId: program.lookId }];
    const error = await saveLibrary({ ...library, rules });
    const look = library.looks.find((l) => l.id === program.lookId)?.name;
    setMessage(error ?? `${look} now plays for ${label}.`);
  }
  return (
    <section className="card">
      <label className="field">
        Look
        <select value={program.lookId} onChange={(e) => client.send({ type: 'look', lookId: e.target.value })}>
          {library.looks.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      {program.palette.length > 0 && (
        <div className="swatches small" aria-label="Palette in use">
          {program.palette.map((c, i) => (
            <span key={i} className="swatch" style={{ background: css(c) }} />
          ))}
        </div>
      )}
      <p className="hint">
        This is {REASONS[program.reason]}.{program.auto && ' The lights started by themselves and stop when the music does.'}{' '}
        {program.reason === 'manual' && (
          <button className="link" onClick={() => client.send({ type: 'look', lookId: null })}>
            Back to the rules
          </button>
        )}
      </p>
      {track && (
        <details>
          <summary>Always play this look for…</summary>
          <div className="row wrap">
            <button onClick={() => void addRule('track', `spotify:track:${track.id}`, `“${track.name}”`)}>This song</button>
            {playlist && (
              <button onClick={() => void addRule('playlist', playlist.uri, playlist.name ? `the playlist “${playlist.name}”` : 'this playlist')}>This playlist</button>
            )}
            {artist && <button onClick={() => void addRule('artist', artist.uri, artist.name)}>{artist.name}</button>}
          </div>
        </details>
      )}
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function Live({ state, client }: { state: LiveState; client: LiveClient }) {
  const { master, running, hue } = state;
  const setMaster = (m: Partial<LiveState['master']>) => client.send({ type: 'master', master: m });
  return (
    <main>
      <NowPlaying state={state} />
      <section className="card">
        <button
          className={`primary big${running ? ' stop' : ''}`}
          disabled={!hue.paired && !running}
          onClick={() => client.send({ type: 'run', running: !running })}
        >
          {running ? 'Stop lights' : 'Start lights'}
        </button>
        <p className={`status${state.output.status === 'error' ? ' error' : ''}`} role="status">
          {outputText(state)}
        </p>
        {hue.lights.some((l) => l.id && stageFixtures(state.layout).some((f) => f.id === l.id)) ? (
          <PlanPreview client={client} state={state} />
        ) : (
          <Preview client={client} names={hue.lights.map((l) => l.name)} />
        )}
      </section>
      <LookPicker state={state} client={client} />
      <section className="card">
        <Slider label="Brightness" value={master.brightness} onChange={(brightness) => setMaster({ brightness })} />
        <Slider label="Intensity" value={master.intensity} onChange={(intensity) => setMaster({ intensity })} />
        <Delay value={master.delayMs} onChange={(delayMs) => setMaster({ delayMs })} />
        <button className={`toggle${master.blackout ? ' on' : ''}`} aria-pressed={master.blackout} onClick={() => setMaster({ blackout: !master.blackout })}>
          Blackout
        </button>
      </section>
      {state.layout.groups.length > 0 && (
        <section className="card">
          {state.layout.groups.map((g) => (
            <Slider
              key={g.id}
              label={g.name}
              value={master.groups[g.id] ?? 1}
              onChange={(v) => setMaster({ groups: { ...master.groups, [g.id]: v } })}
            />
          ))}
        </section>
      )}
    </main>
  );
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, '0')}`;

function NowPlaying({ state }: { state: LiveState }) {
  const now = useNow(500);
  const { spotify } = state;
  if (!spotify.linked) {
    return (
      <section className="card muted">
        Spotify isn’t linked yet. <a href="#setup">Link it in Setup</a>.
      </section>
    );
  }
  const track = spotify.track;
  if (!track) return <section className="card muted">Nothing is playing on Spotify.</section>;
  const elapsed = spotify.playing && spotify.at ? now - spotify.at : 0;
  const position = Math.min(track.durationMs, Math.max(0, (spotify.progressMs ?? 0) + elapsed));
  return (
    <section className="card now">
      {track.artUrl ? <img src={track.artUrl} alt="" width={84} height={84} /> : <div className="art" />}
      <div className="meta">
        <div className="title">{track.name}</div>
        <div className="sub">{track.artists}</div>
        <div className="sub">
          {spotify.playing ? 'Playing' : 'Paused'} on {spotify.device?.name ?? 'an unknown device'}
        </div>
        <div className="sub">{MODE_TEXT[state.mode]}</div>
        <div className="progress">
          <progress max={track.durationMs} value={position} aria-label="Track position" />
          <span>
            {clock(position)} / {clock(track.durationMs)}
          </span>
        </div>
      </div>
    </section>
  );
}

function Preview({ client, names }: { client: LiveClient; names: string[] }) {
  const colors = useSyncExternalStore(client.subscribeFrames, client.getColors);
  return (
    <ul className="preview" aria-label="Light preview">
      {colors.map((color, i) => (
        <li key={i}>
          <span className="bulb" style={{ background: color, boxShadow: `0 0 18px ${color}` }} />
          <span className="name">{names[i] ?? `Light ${i + 1}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  const [local, setLocal] = useState(value);
  const editedAt = useRef(0);
  // Follow the server, except right after a local change (its echo may be stale).
  useEffect(() => {
    if (Date.now() - editedAt.current > 600) setLocal(value);
  }, [value]);
  const percent = Math.round(local * 100);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={percent}
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          editedAt.current = Date.now();
          setLocal(v);
          onChange(v);
        }}
      />
      <output htmlFor={id}>{percent}%</output>
    </div>
  );
}

function Delay({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const set = (v: number) => onChange(Math.max(0, Math.min(1000, v)));
  return (
    <div className="field">
      <span id="delay-label">Light delay</span>
      <div className="stepper" role="group" aria-labelledby="delay-label">
        <button aria-label="10 ms earlier" onClick={() => set(value - 10)}>
          −
        </button>
        <output aria-live="polite">{value} ms</output>
        <button aria-label="10 ms later" onClick={() => set(value + 10)}>
          +
        </button>
      </div>
    </div>
  );
}

// ---- Setup ----

function Setup({ state, onSignedOut }: { state: LiveState; onSignedOut: () => void }) {
  return (
    <main>
      <HueSetup hue={state.hue} />
      <SpotifySetup spotify={state.spotify} />
      <AgentSetup agent={state.agent} />
      <section className="card">
        <button onClick={() => void post('/api/logout').finally(onSignedOut)}>Sign out</button>
      </section>
    </main>
  );
}

function HueSetup({ hue }: { hue: LiveState['hue'] }) {
  const [ip, setIp] = useState(hue.bridgeIp ?? '');
  const [pairing, setPairing] = useState<{ busy: boolean; message: string; error?: boolean }>();
  async function pair(e: FormEvent) {
    e.preventDefault();
    const until = Date.now() + 60_000;
    setPairing({ busy: true, message: 'Press the round link button on top of the bridge now…' });
    while (Date.now() < until) {
      const res = await post('/api/hue/pair', { ip }).catch(() => undefined);
      if (!res?.ok) {
        setPairing({ busy: false, error: true, message: res?.data.error ?? 'Can’t reach the server' });
        return;
      }
      if (res.data.status === 'paired') {
        setPairing({ busy: false, message: 'Paired.' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    setPairing({ busy: false, error: true, message: 'The link button wasn’t pressed in time. Try again.' });
  }
  return (
    <section className="card">
      <h2>Hue bridge</h2>
      <p>
        {hue.paired
          ? `Paired with bridge ${hue.bridgeId} at ${hue.bridgeIp}. ${hue.lights.length} lights in the “musicsync” Entertainment area.`
          : 'Not paired yet.'}
      </p>
      {hue.error && <p className="error">{hue.error}</p>}
      {hue.lights.length > 0 && <p className="hint">{hue.lights.map((l) => l.name).join(' · ')}</p>}
      <form className="row" onSubmit={pair}>
        <label className="stack grow">
          Bridge IP address
          <input value={ip} onChange={(e) => setIp(e.target.value.trim())} inputMode="decimal" placeholder="e.g. 192.168.1.20" required />
        </label>
        <button className="primary" disabled={pairing?.busy}>
          {hue.paired ? 'Pair again' : 'Pair'}
        </button>
      </form>
      {pairing && (
        <p className={pairing.error ? 'error' : 'hint'} role="status">
          {pairing.message}
        </p>
      )}
    </section>
  );
}

function SpotifySetup({ spotify }: { spotify: LiveState['spotify'] }) {
  return (
    <section className="card">
      <h2>Spotify</h2>
      {spotify.configured ? (
        <>
          <p>{spotify.linked ? 'Linked.' : 'Not linked yet.'}</p>
          {spotify.error && <p className="error">{spotify.error}</p>}
          <a className="button primary" href="/api/spotify/login">
            {spotify.linked ? 'Link again' : 'Link Spotify'}
          </a>
          <p className="hint">
            Your Spotify app needs this redirect URI: <code>{spotify.redirectUri}</code>
          </p>
        </>
      ) : (
        <p>Set SPOTIFY_CLIENT_ID on the server to link Spotify.</p>
      )}
    </section>
  );
}

function AgentSetup({ agent }: { agent: LiveState['agent'] }) {
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  async function show() {
    const res = await fetch('/api/agent-token').catch(() => undefined);
    if (res?.ok) setToken(((await res.json()) as { token: string }).token);
    else setError('Couldn’t load the token');
  }
  return (
    <section className="card">
      <h2>PC loopback agent</h2>
      <p>
        {agent.connected
          ? `Connected: capturing “${agent.device}” at ${agent.framesPerSec ?? 0} frames/s (only while something plays).`
          : 'Not connected.'}
      </p>
      {token ? (
        <>
          <p className="hint">On the PC that plays Spotify, from the musicsync folder:</p>
          <pre>
            npm run agent -- --url {location.origin} --token {token}
          </pre>
        </>
      ) : (
        <button onClick={() => void show()}>Show the agent command</button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
