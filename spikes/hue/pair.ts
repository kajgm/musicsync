// Spike 1a: pair with the bridge (link button) and keep the app key + DTLS client key.
// Usage: npm run hue:pair -- [timeoutSeconds] [--force]
import { BRIDGE_ID, BRIDGE_IP, hueRequest, type HueCreds } from '../lib/hue.ts';
import { readLocal, sleep, writeLocal } from '../lib/local.ts';

type PairReply = Array<{
  success?: { username: string; clientkey: string };
  error?: { type: number; description: string };
}>;

const timeoutSec = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 180);

if (readLocal<HueCreds>('hue.json') && !process.argv.includes('--force')) {
  console.log('Already paired (spikes/.local/hue.json exists). Pass --force to pair again.');
  process.exit(0);
}

console.log(`Pairing with Hue bridge ${BRIDGE_ID} at ${BRIDGE_IP}.`);
console.log(`Press the round link button on top of the bridge. Waiting up to ${timeoutSec} s...`);

const deadline = Date.now() + timeoutSec * 1000;
let lastMessage = '';
while (Date.now() < deadline) {
  const res = await hueRequest<PairReply>('POST', '/api', {
    body: { devicetype: 'musicsync#phase0-spike', generateclientkey: true },
  });
  const reply = Array.isArray(res.data) ? res.data[0] : undefined;
  if (reply?.success) {
    const creds: HueCreds = {
      bridgeIp: BRIDGE_IP,
      bridgeId: BRIDGE_ID,
      appKey: reply.success.username,
      clientKey: reply.success.clientkey,
      certFingerprint256: res.fingerprint256,
      pairedAt: new Date().toISOString(),
    };
    writeLocal('hue.json', creds);
    console.log('Paired. App key and client key saved to spikes/.local/hue.json (gitignored).');
    process.exit(0);
  }
  const message = reply?.error ? `${reply.error.type}: ${reply.error.description}` : `HTTP ${res.status}`;
  if (message !== lastMessage) {
    console.log(`  bridge says ${message}`);
    lastMessage = message;
  }
  await sleep(2000);
}

console.error('Timed out: the link button was not pressed in time. Run `npm run hue:pair` again.');
process.exit(1);
