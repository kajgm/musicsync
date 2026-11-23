// Deploy-time settings from the environment (architecture §10.2).
import { fileURLToPath } from 'node:url';

export type Config = {
  port: number;
  host: string;
  /** Origin clients use, e.g. https://musicsync.example.com. Sets the Spotify redirect URI. */
  publicUrl: string;
  dataDir: string;
  webDir: string;
  version: string;
  /** Encrypts runtime secrets (Hue keys, Spotify tokens) and signs session cookies. */
  masterKey: Buffer;
  adminPasswordHash: string;
  spotifyClientId?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const masterKey = env.MUSICSYNC_MASTER_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(masterKey)) {
    throw new Error('MUSICSYNC_MASTER_KEY must be 32 random bytes as 64 hex characters (openssl rand -hex 32)');
  }
  const adminPasswordHash = env.ADMIN_PASSWORD_HASH ?? '';
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(adminPasswordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash (npm run hash-password)');
  }
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl: new URL(env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).origin,
    dataDir: env.DATA_DIR ?? fileURLToPath(new URL('../../../.data', import.meta.url)),
    webDir: env.WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
    version: env.APP_VERSION ?? 'dev',
    masterKey: Buffer.from(masterKey, 'hex'),
    adminPasswordHash,
    spotifyClientId: env.SPOTIFY_CLIENT_ID || undefined,
  };
}
