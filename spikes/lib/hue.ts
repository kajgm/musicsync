// Minimal Hue bridge client for the spikes: pairing endpoint + CLIP v2 resources.
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { readLocal } from './local.ts';

// From the environment when pairing; afterwards from what pairing saved.
const saved = readLocal<HueCreds>('hue.json');
export const BRIDGE_IP = process.env.HUE_BRIDGE_IP ?? saved?.bridgeIp ?? '';
export const BRIDGE_ID = (process.env.HUE_BRIDGE_ID ?? saved?.bridgeId ?? '').toUpperCase();
if (!BRIDGE_IP || !BRIDGE_ID) {
  throw new Error('Set HUE_BRIDGE_IP and HUE_BRIDGE_ID (see https://discovery.meethue.com or https://<bridge-ip>/api/0/config).');
}

export type HueCreds = {
  bridgeIp: string;
  bridgeId: string;
  /** "username" from pairing; also the DTLS PSK identity. */
  appKey: string;
  /** 32 hex chars from pairing; the DTLS pre-shared key. */
  clientKey: string;
  /** Bridge certificate fingerprint recorded at pairing (trust on first use). */
  certFingerprint256: string;
  pairedAt: string;
};

type Ref = { rid: string; rtype: string };

export type Light = {
  id: string;
  owner: Ref;
  metadata: { name: string; archetype?: string };
  color?: { gamut_type?: string };
};

export type EntertainmentService = {
  id: string;
  owner: Ref;
  renderer: boolean;
};

export type EntertainmentConfig = {
  id: string;
  metadata: { name: string };
  configuration_type: string;
  status: 'active' | 'inactive';
  active_streamer?: Ref;
  channels: Array<{
    channel_id: number;
    position: { x: number; y: number; z: number };
    members: Array<{ service: Ref; index: number }>;
  }>;
};

// Full TLS handshake on every new connection: a resumed session doesn't present the
// bridge certificate again, which made the CN check fail on later requests.
const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0 });

export function loadCreds(): HueCreds {
  const creds = readLocal<HueCreds>('hue.json');
  if (!creds) throw new Error('No .local/hue.json yet: run `npm run hue:pair` first.');
  return creds;
}

/**
 * HTTPS request to the bridge. Its certificate is issued by Philips Hue's private
 * "root-bridge" CA with CN = bridge ID, so Node can't verify it by default. Phase 0
 * checks the CN and, after pairing, the fingerprint recorded then. Phase 1 verifies
 * the CA chain instead.
 */
export function hueRequest<T>(
  method: string,
  path: string,
  opts: { appKey?: string; body?: unknown; fingerprint256?: string; timeoutMs?: number } = {},
): Promise<{ status: number; data: T; fingerprint256: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = https.request(
      {
        host: BRIDGE_IP,
        port: 443,
        method,
        path,
        agent,
        rejectUnauthorized: false,
        timeout: opts.timeoutMs ?? 5000,
        headers: {
          ...(opts.appKey ? { 'hue-application-key': opts.appKey } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const cert = (res.socket as TLSSocket).getPeerCertificate();
        const fingerprint256 = cert.fingerprint256 ?? '';
        const cn = [cert.subject?.CN ?? ''].flat()[0] ?? '';
        if (cn.toUpperCase() !== BRIDGE_ID) {
          res.destroy();
          reject(new Error(`Bridge certificate CN "${cn}" is not bridge ID ${BRIDGE_ID}`));
          return;
        }
        if (opts.fingerprint256 && opts.fingerprint256 !== fingerprint256) {
          res.destroy();
          reject(new Error('Bridge certificate changed since pairing'));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown = text;
          try {
            data = text ? JSON.parse(text) : undefined;
          } catch {
            // not JSON: keep the text
          }
          resolve({ status: res.statusCode ?? 0, data: data as T, fingerprint256 });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout: ${method} ${path}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** CLIP v2 call with the stored app key. Throws on HTTP or API errors. */
export async function clip<T>(method: string, resource: string, body?: unknown): Promise<T[]> {
  const creds = loadCreds();
  const res = await hueRequest<{ errors?: Array<{ description: string }>; data?: T[] }>(
    method,
    `/clip/v2/resource/${resource}`,
    { appKey: creds.appKey, body, fingerprint256: creds.certFingerprint256 },
  );
  const errors = res.data?.errors ?? [];
  if (res.status >= 400 || errors.length > 0) {
    const detail = errors.map((e) => e.description).join('; ') || JSON.stringify(res.data);
    throw new Error(`${method} ${resource}: HTTP ${res.status}: ${detail}`);
  }
  return res.data?.data ?? [];
}
