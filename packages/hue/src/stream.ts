// Hue Entertainment streaming: start the area over CLIP v2, then send HueStream v2 frames
// over DTLS 1.2 (PSK, TLS_PSK_WITH_AES_128_GCM_SHA256) to UDP 2100.
import { dtls } from 'node-dtls-client';
import { clip, type HueCreds } from './bridge.ts';

const HEADER_BYTES = 52;
const CHANNEL_BYTES = 7;

/** A HueStream v2 message (RGB colour space, 16 bits per component) with the colours left at 0. */
export function hueStreamBuffer(areaId: string, channels: ArrayLike<number>): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES + CHANNEL_BYTES * channels.length);
  buf.write('HueStream', 0, 'ascii'); // 0-8   protocol name
  buf[9] = 0x02; //                      9-10  version 2.0
  buf[10] = 0x00; //                     11    sequence id (the bridge ignores it)
  //                                     12-13 reserved
  buf[14] = 0x00; //                     14    colour space: 0 = RGB, 1 = XY + brightness
  //                                     15    reserved
  buf.write(areaId, 16, 36, 'ascii'); // 16-51 entertainment configuration id
  for (let i = 0; i < channels.length; i++) buf[HEADER_BYTES + i * CHANNEL_BYTES] = channels[i];
  return buf;
}

/** Writes r, g, b (0..1) per channel into a buffer from hueStreamBuffer. */
export function writeColors(buf: Buffer, rgb: Float32Array, sequence: number): void {
  buf[11] = sequence & 0xff;
  const n = (buf.length - HEADER_BYTES) / CHANNEL_BYTES;
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + i * CHANNEL_BYTES + 1;
    for (let c = 0; c < 3; c++) {
      const v = rgb[i * 3 + c];
      buf.writeUInt16BE(Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 0xffff), o + c * 2);
    }
  }
}

export type HueStream = {
  handshakeMs: number;
  /** r, g, b (0..1) per channel, in the order the stream was opened with. */
  send(rgb: Float32Array): void;
  /** Called once if the connection drops; the stream is then dead. */
  onDown(cb: (reason: string) => void): void;
  /** Closes the connection and gives the lights back to the bridge. */
  close(): Promise<void>;
};

export async function openHueStream(creds: HueCreds, areaId: string, channels: number[]): Promise<HueStream> {
  const stopArea = () => clip(creds, 'PUT', `entertainment_configuration/${areaId}`, { action: 'stop' });
  await clip(creds, 'PUT', `entertainment_configuration/${areaId}`, { action: 'start' });

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
    await stopArea().catch(() => undefined);
    throw err;
  }
  const handshakeMs = performance.now() - started;

  const buf = hueStreamBuffer(areaId, channels);
  let sequence = 0;
  let closed = false;
  let onDown: ((reason: string) => void) | undefined;
  const down = (reason: string) => {
    if (closed) return;
    closed = true;
    onDown?.(reason);
  };
  socket.on('error', (err: Error) => down(`DTLS error: ${err.message}`));
  socket.on('close', () => down('the bridge closed the DTLS connection'));

  return {
    handshakeMs,
    send(rgb) {
      if (closed) return;
      writeColors(buf, rgb, sequence++);
      socket.send(buf); // encrypted synchronously, so the buffer can be reused
    },
    onDown(cb) {
      onDown = cb;
    },
    async close() {
      if (!closed) {
        closed = true;
        await new Promise<void>((resolve) => socket.close(() => resolve()));
      }
      await stopArea();
    },
  };
}
