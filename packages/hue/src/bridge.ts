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

/** `lights[].id`: the entertainment service id of the channel's light. */
export type Area = { id: string; lights: Array<{ channel: number; name: string; id?: string }> };

/** An area holds at most this many lights. */
export const AREA_MAX = 10;

/** A light in the area: entertainment service id and position in Hue's −1..1 space (x right, y front, z up). */
export type Location = { id: string; x: number; y: number; z: number };

export type Device = { id: string; name: string; streamable: boolean };

export type AreaSync = {
  area: Area;
  /** Every light on the bridge, by entertainment service id. */
  devices: Device[];
};

const sameLocations = (area: EntertainmentConfig, want: Location[]) =>
  area.channels.length === want.length &&
  want.every((w) => {
    const c = area.channels.find((ch) => ch.members[0]?.service.rid === w.id);
    return c && Math.abs(c.position.x - w.x) < 0.01 && Math.abs(c.position.y - w.y) < 0.01 && Math.abs(c.position.z - w.z) < 0.01;
  });

/**
 * The app's Entertainment area. When `want` (given the bridge's lights) returns locations,
 * the area's lights and positions are set to them; `beforeChange` runs first so the caller
 * can stop streaming. Otherwise an existing area is left as it is and a missing one is
 * made from every streamable light in a line. Areas made in the Hue app are left alone.
 */
export async function syncArea(
  creds: HueCreds,
  want: (devices: Device[]) => Location[] | undefined = () => undefined,
  beforeChange: () => Promise<void> = async () => {},
): Promise<AreaSync> {
  const [lights, services, areas] = await Promise.all([
    clip<Light>(creds, 'GET', 'light'),
    clip<EntertainmentService>(creds, 'GET', 'entertainment'),
    clip<EntertainmentConfig>(creds, 'GET', 'entertainment_configuration'),
  ]);
  const nameByDevice = new Map(lights.map((l) => [l.owner.rid, l.metadata.name]));
  const devices = services
    .filter((s) => nameByDevice.has(s.owner.rid)) // the bridge itself has an entertainment service too
    .map((s) => ({ id: s.id, name: nameByDevice.get(s.owner.rid)!, streamable: s.renderer }));

  let area = areas.find((a) => a.metadata.name === AREA_NAME);
  let locations = want(devices);
  if (!locations && !area) {
    const renderers = devices.filter((d) => d.streamable).slice(0, AREA_MAX);
    const xAt = (i: number) => (renderers.length === 1 ? 0 : -1 + (2 * i) / (renderers.length - 1));
    locations = renderers.map((d, i) => ({ id: d.id, x: xAt(i), y: 0.8, z: 0 }));
  }
  if (locations && (!area || !sameLocations(area, locations))) {
    if (locations.length === 0) throw new Error('The bridge has no lights that can join an Entertainment area');
    const body = {
      locations: {
        service_locations: locations.map((l) => ({
          service: { rid: l.id, rtype: 'entertainment' },
          positions: [{ x: l.x, y: l.y, z: l.z }],
        })),
      },
    };
    let id = area?.id;
    if (id) {
      await beforeChange();
      await clip(creds, 'PUT', `entertainment_configuration/${id}`, body);
    } else {
      const [created] = await clip<{ rid: string }>(creds, 'POST', 'entertainment_configuration', {
        type: 'entertainment_configuration',
        metadata: { name: AREA_NAME },
        configuration_type: 'music',
        ...body,
      });
      id = created?.rid;
      if (!id) throw new Error('The bridge returned no id for the new Entertainment area');
    }
    [area] = await clip<EntertainmentConfig>(creds, 'GET', `entertainment_configuration/${id}`);
    if (!area) throw new Error('The Entertainment area disappeared');
  }
  if (!area) throw new Error('No Entertainment area'); // unreachable: made above
  const nameById = new Map(devices.map((d) => [d.id, d.name]));
  return {
    devices,
    area: {
      id: area.id,
      lights: area.channels.map((c) => {
        const id = c.members[0]?.service.rid;
        return { channel: c.channel_id, id, name: (id && nameById.get(id)) || `Channel ${c.channel_id}` };
      }),
    },
  };
}

/**
 * Follows the bridge's event stream (CLIP v2 SSE) and calls `onChange` when lights are
 * added, removed or renamed. Reconnects until `stop()` is called.
 */
export function watchDevices(creds: HueCreds, onChange: () => void): { stop(): void } {
  let req: ReturnType<typeof https.request> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  const connect = () => {
    let buffered = '';
    req = https.request(
      {
        host: creds.bridgeIp,
        port: 443,
        path: '/eventstream/clip/v2',
        agent: false,
        ca: HUE_ROOT_CAS,
        checkServerIdentity: (_host, cert) =>
          String([cert.subject?.CN ?? ''].flat()[0] ?? '').toUpperCase() === creds.bridgeId.toUpperCase()
            ? undefined
            : new Error(`The certificate at ${creds.bridgeIp} isn't for bridge ${creds.bridgeId}`),
        headers: { 'hue-application-key': creds.appKey, accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) if (line.startsWith('data:') && isDeviceChange(line.slice(5))) onChange();
        });
        res.on('end', () => again());
      },
    );
    req.setTimeout(0);
    req.on('error', () => again());
    req.end();
  };
  const again = () => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(connect, 5000);
  };
  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      req?.destroy();
    },
  };
}

type HueEvent = { type: string; data?: Array<{ type?: string; metadata?: unknown }> };

/** An add or delete of a light/device/entertainment resource, or a rename. Colour changes are not. */
export function isDeviceChange(json: string): boolean {
  let events: HueEvent[];
  try {
    events = JSON.parse(json) as HueEvent[];
  } catch {
    return false;
  }
  const kinds = new Set(['light', 'device', 'entertainment']);
  return events.some((e) =>
    (e.data ?? []).some((d) => kinds.has(d.type ?? '') && (e.type === 'add' || e.type === 'delete' || d.metadata !== undefined)),
  );
}
