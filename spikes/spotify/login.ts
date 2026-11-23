// Spike 2a: link Spotify with Authorization Code + PKCE (no client secret) through a
// loopback redirect, and save the tokens to spikes/.local/spotify.json.
// Prerequisite: add http://127.0.0.1:8888/callback as a Redirect URI in your Spotify app.
// Usage: npm run spotify:login -- <client-id>
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readLocal, writeLocal } from '../lib/local.ts';
import { REDIRECT_URI, SCOPES, requestToken, type SpotifyCreds } from '../lib/spotify.ts';

const clientId = process.argv[2] ?? process.env.SPOTIFY_CLIENT_ID ?? readLocal<SpotifyCreds>('spotify.json')?.clientId;
if (!clientId) {
  console.error('Usage: npm run spotify:login -- <client-id>   (from developer.spotify.com/dashboard)');
  process.exit(1);
}

const verifier = randomBytes(64).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');
const authorize = new URL('https://accounts.spotify.com/authorize');
authorize.search = new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  scope: SCOPES.join(' '),
  redirect_uri: REDIRECT_URI,
  code_challenge_method: 'S256',
  code_challenge: challenge,
  state,
}).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT_URI);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error') ?? (url.searchParams.get('state') !== state ? 'state mismatch' : null);
    const received = url.searchParams.get('code');
    if (error || !received) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`Spotify login failed: ${error ?? 'no code'}`);
      server.close();
      reject(new Error(`Spotify login failed: ${error ?? 'no code'}`));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>musicsync: Spotify is linked. You can close this tab.</p>');
    server.close();
    resolve(received);
  });
  server.listen(8888, '127.0.0.1', () => {
    console.log('Opening the Spotify login page in your browser...');
    console.log(`If it doesn't open, visit:\n${authorize}\n`);
    // rundll32 opens the default browser without a shell, so the "&"s in the URL survive.
    spawn('rundll32', ['url.dll,FileProtocolHandler', authorize.toString()], { stdio: 'ignore', detached: true }).unref();
  });
  setTimeout(() => {
    server.close();
    reject(new Error('Timed out after 5 minutes waiting for the Spotify login'));
  }, 5 * 60_000).unref();
});

const reply = await requestToken({
  grant_type: 'authorization_code',
  code,
  redirect_uri: REDIRECT_URI,
  client_id: clientId,
  code_verifier: verifier,
});
if (!reply.refresh_token) throw new Error('Spotify returned no refresh token');
writeLocal('spotify.json', {
  clientId,
  refreshToken: reply.refresh_token,
  accessToken: reply.access_token,
  expiresAt: Date.now() + reply.expires_in * 1000,
  scope: reply.scope,
} satisfies SpotifyCreds);
console.log(`Linked (scopes: ${reply.scope}). Tokens saved to spikes/.local/spotify.json (gitignored).`);
