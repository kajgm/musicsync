// Hue bridge over HTTPS: link-button pairing, CLIP v2 resources and the Entertainment area.
import https from 'node:https';
import { HUE_ROOT_CAS } from './ca.ts';

export type HueCreds = {
  bridgeIp: string;
  /** Bridge ID, the CN of its certificate. */
  bridgeId: string;
  /** "username" from pairing; also the DTLS PSK identity. */
  appKey: string;
  /** 32 hex characters from pairing: the DTLS pre-shared key. */
  clientKey: string;
};

type Ref = { rid: string; rtype: string };

export type Light = { id: string; owner: Ref; metadata: { name: string } };
export type EntertainmentService = { id: string; owner: Ref; renderer: boolean };
export type EntertainmentConfig = {
  id: string;
  metadata: { name: string };
  status: 'active' | 'inactive';
  channels: Array<{
    channel_id: number;
    position: { x: number; y: number; z: number };
    members: Array<{ service: Ref; index: number }>;
  }>;
};

/**
 * HTTPS request to a bridge. The certificate must chain to a Hue root CA and, once the
 * bridge ID is known, carry it as CN; that is checked during the handshake, before the
 * app key is sent. No connection reuse, so every request gets that full check.
 */
export function hueRequest<T>(
  ip: string,
  method: string,
  path: string,
  opts: { bridgeId?: string; appKey?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; data: T; bridgeId: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    let certId = '';
    const req = https.request(
      {
        host: ip,
        port: 443,
        method,
        path,
        agent: false,
        ca: HUE_ROOT_CAS,
        timeout: opts.timeoutMs ?? 5000,
        checkServerIdentity: (_host, cert) => {
          certId = String([cert.subject?.CN ?? ''].flat()[0] ?? '').toUpperCase();
          if (opts.bridgeId && certId !== opts.bridgeId.toUpperCase()) {
            return new Error(`The certificate at ${ip} is for bridge ${certId}, not ${opts.bridgeId}`);
          }
          return undefined;
        },
        headers: {
          ...(opts.appKey ? { 'hue-application-key': opts.appKey } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
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
          resolve({ status: res.statusCode ?? 0, data: data as T, bridgeId: certId });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Hue bridge ${ip} timed out: ${method} ${path}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * One pairing attempt. Resolves undefined while the link button hasn't been pressed
 * (the bridge accepts pairing for 30 s after a press), so callers retry every few seconds.
 */
export async function pair(ip: string, devicetype: string): Promise<HueCreds | undefined> {
  type Reply = Array<{
    success?: { username: string; clientkey: string };
    error?: { type: number; description: string };
  }>;
  const res = await hueRequest<Reply>(ip, 'POST', '/api', { body: { devicetype, generateclientkey: true } });
  const reply = Array.isArray(res.data) ? res.data[0] : undefined;
  if (reply?.success) {
    return { bridgeIp: ip, bridgeId: res.bridgeId, appKey: reply.success.username, clientKey: reply.success.clientkey };
  }
  if (reply?.error?.type === 101) return undefined; // link button not pressed
  throw new Error(`Pairing failed: ${reply?.error?.description ?? `HTTP ${res.status}`}`);
}

/** CLIP v2 call. Throws on HTTP or API errors. */
export async function clip<T>(creds: HueCreds, method: string, resource: string, body?: unknown): Promise<T[]> {
  const res = await hueRequest<{ errors?: Array<{ description: string }>; data?: T[] }>(
    creds.bridgeIp,
    method,
    `/clip/v2/resource/${resource}`,
    { bridgeId: creds.bridgeId, appKey: creds.appKey, body },
  );
  const errors = res.data?.errors ?? [];
  if (res.status >= 400 || errors.length > 0) {
    const detail = errors.map((e) => e.description).join('; ') || JSON.stringify(res.data);
    throw new Error(`Hue ${method} ${resource}: HTTP ${res.status}: ${detail}`);
  }
  return res.data?.data ?? [];
}

export const AREA_NAME = 'musicsync';

export type Area = { id: string; lights: Array<{ channel: number; name: string }> };

/**
 * The app's Entertainment area, created from every entertainment-capable light if it
 * doesn't exist yet. Areas made in the Hue app are left alone.
 * shortcut: lights spread along a line; Phase 2 creates and positions it from the floor plan.
 */
export async function ensureArea(creds: HueCreds): Promise<Area> {
  const [lights, services, areas] = await Promise.all([
    clip<Light>(creds, 'GET', 'light'),
    clip<EntertainmentService>(creds, 'GET', 'entertainment'),
    clip<EntertainmentConfig>(creds, 'GET', 'entertainment_configuration'),
  ]);
  let area = areas.find((a) => a.metadata.name === AREA_NAME);
  if (!area) {
    const renderers = services.filter((s) => s.renderer);
    if (renderers.length === 0) throw new Error('The bridge has no lights that can join an Entertainment area');
    const xAt = (i: number) => (renderers.length === 1 ? 0 : -1 + (2 * i) / (renderers.length - 1));
    const [created] = await clip<{ rid: string }>(creds, 'POST', 'entertainment_configuration', {
      type: 'entertainment_configuration',
      metadata: { name: AREA_NAME },
      configuration_type: 'music',
      locations: {
        service_locations: renderers
          .slice(0, 10) // an area holds at most 10 lights
          .map((s, i) => ({ service: { rid: s.id, rtype: 'entertainment' }, positions: [{ x: xAt(i), y: 0.8, z: 0 }] })),
      },
    });
    if (!created) throw new Error('The bridge returned no id for the new Entertainment area');
    [area] = await clip<EntertainmentConfig>(creds, 'GET', `entertainment_configuration/${created.rid}`);
    if (!area) throw new Error('The new Entertainment area disappeared');
  }
  const nameByDevice = new Map(lights.map((l) => [l.owner.rid, l.metadata.name]));
  const deviceByService = new Map(services.map((s) => [s.id, s.owner.rid]));
  return {
    id: area.id,
    lights: area.channels.map((c) => ({
      channel: c.channel_id,
      name: nameByDevice.get(deviceByService.get(c.members[0]?.service.rid ?? '') ?? '') ?? `Channel ${c.channel_id}`,
    })),
  };
}
