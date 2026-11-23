// Hue Entertainment streaming: start the area over CLIP v2, then send HueStream v2
// frames over DTLS 1.2 (PSK, TLS_PSK_WITH_AES_128_GCM_SHA256) to UDP 2100.
import { dtls } from 'node-dtls-client';
import { clamp01, type RGB } from './color.ts';
import { clip, type EntertainmentConfig, type HueCreds } from './hue.ts';

export type ChannelColor = { channel: number; rgb: RGB };

const PROTOCOL = Buffer.from('HueStream', 'ascii');
const HEADER_BYTES = 52;
const CHANNEL_BYTES = 7;

/** One HueStream v2 message, RGB colour space, 16 bits per component. */
export function encodeHueStream(areaId: string, colors: ChannelColor[], sequence: number): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES + CHANNEL_BYTES * colors.length);
  PROTOCOL.copy(buf, 0); //            0-8   "HueStream"
  buf[9] = 0x02; //                    9-10  version 2.0
  buf[10] = 0x00;
  buf[11] = sequence & 0xff; //        11    sequence id (the bridge ignores it)
  //                                   12-13 reserved
  buf[14] = 0x00; //                   14    colour space: 0 = RGB, 1 = XY + brightness
  //                                   15    reserved
  buf.write(areaId, 16, 36, 'ascii'); // 16-51 entertainment configuration id
  let offset = HEADER_BYTES;
  for (const { channel, rgb } of colors) {
    buf[offset] = channel;
    buf.writeUInt16BE(Math.round(clamp01(rgb[0]) * 0xffff), offset + 1);
    buf.writeUInt16BE(Math.round(clamp01(rgb[1]) * 0xffff), offset + 3);
    buf.writeUInt16BE(Math.round(clamp01(rgb[2]) * 0xffff), offset + 5);
    offset += CHANNEL_BYTES;
  }
  return buf;
}

export type HueStream = {
  handshakeMs: number;
  readonly sendErrors: number;
  send(colors: ChannelColor[]): void;
  close(): Promise<void>;
};

export async function openHueStream(creds: HueCreds, area: EntertainmentConfig): Promise<HueStream> {
  await clip('PUT', `entertainment_configuration/${area.id}`, { action: 'start' });

  const started = performance.now();
  const socket = dtls.createSocket({
    type: 'udp4',
    address: creds.bridgeIp,
    port: 2100,
    psk: { [creds.appKey]: Buffer.from(creds.clientKey, 'hex') },
    timeout: 10_000,
    ciphers: ['TLS_PSK_WITH_AES_128_GCM_SHA256'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connected', () => resolve());
      socket.once('error', (err: Error) => reject(err));
      socket.once('close', () => reject(new Error('DTLS socket closed during the handshake')));
    });
  } catch (err) {
    await clip('PUT', `entertainment_configuration/${area.id}`, { action: 'stop' }).catch(() => undefined);
    throw err;
  }
  const handshakeMs = performance.now() - started;

  let sequence = 0;
  let sendErrors = 0;
  socket.on('error', (err: Error) => {
    sendErrors++;
    console.error(`DTLS error: ${err.message}`);
  });

  let closed = false;
  return {
    handshakeMs,
    get sendErrors() {
      return sendErrors;
    },
    send(colors) {
      if (!closed) socket.send(encodeHueStream(area.id, colors, sequence++));
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      await clip('PUT', `entertainment_configuration/${area.id}`, { action: 'stop' });
    },
  };
}
