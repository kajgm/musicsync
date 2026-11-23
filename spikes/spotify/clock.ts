// Spike 2b: how good is Spotify's playback position? Polls GET /me/player and measures
// how far each reported position strays from a steady clock, per playback device.
// Play a track on the PC, then on the phone. Usage: npm run spotify:clock -- [intervalMs] [--seconds N]
import { appendFileSync, writeFileSync } from 'node:fs';
import { localPath, sleep } from '../lib/local.ts';
import { getPlayer } from '../lib/spotify.ts';

const intervalMs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 1000);
const secondsArg = process.argv.indexOf('--seconds');
const runForMs = secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) * 1000 : Number.POSITIVE_INFINITY;

const csv = localPath(`clock-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
writeFileSync(csv, 'time_ms,device,type,track,is_playing,progress_ms,rtt_ms,offset_ms,residual_ms\n');

type Segment = { device: string; track: string; offsets: number[] };
type DeviceStats = { residuals: number[]; rtts: number[]; jumps: number };
const byDevice = new Map<string, DeviceStats>();
let segment: Segment | undefined;
let lastProgress = 0;
let lastMid = 0;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

console.log(`Polling GET /me/player every ${intervalMs} ms. Writing ${csv}`);
console.log('Columns: device · track · position · deviation from a steady clock · round trip. Ctrl+C for the summary.\n');

const started = performance.now();
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});

while (!stopping && performance.now() - started < runForMs) {
  const tickStart = performance.now();
  const res = await getPlayer();
  const rtt = res.receivedAt - res.sentAt;
  const mid = res.sentAt + rtt / 2;
  if (res.status === 429) {
    console.log(`rate limited: waiting ${res.retryAfterS} s`);
    await sleep((res.retryAfterS ?? 5) * 1000);
    continue;
  }
  const st = res.state;
  if (!st || st.progress_ms == null || !st.item) {
    console.log(res.status === 204 ? 'nothing playing' : `HTTP ${res.status}`);
    segment = undefined;
  } else {
    const device = `${st.device?.name ?? '?'} (${st.device?.type ?? '?'})`;
    const track = st.item.name;
    const stats = byDevice.get(device) ?? { residuals: [], rtts: [], jumps: 0 };
    byDevice.set(device, stats);
    stats.rtts.push(rtt);
    // offset = reported position − local clock. A steady clock keeps it constant while playing.
    const offset = st.progress_ms - mid;
    const predicted = lastProgress + (mid - lastMid);
    const jumped =
      !segment || segment.device !== device || segment.track !== track || !st.is_playing || Math.abs(st.progress_ms - predicted) > 1500;
    if (jumped) {
      if (segment) stats.jumps++;
      segment = st.is_playing ? { device, track, offsets: [] } : undefined;
    }
    let residual = Number.NaN;
    if (segment && st.is_playing) {
      segment.offsets.push(offset);
      if (segment.offsets.length >= 3) {
        residual = offset - median(segment.offsets);
        stats.residuals.push(residual);
      }
    }
    lastProgress = st.progress_ms;
    lastMid = mid;
    appendFileSync(
      csv,
      `${Date.now()},"${device}","${st.device?.type ?? ''}","${track.replace(/"/g, "'")}",${st.is_playing},${st.progress_ms},${rtt.toFixed(1)},${offset.toFixed(1)},${Number.isNaN(residual) ? '' : residual.toFixed(1)}\n`,
    );
    console.log(
      `${device.padEnd(32).slice(0, 32)} ${track.padEnd(28).slice(0, 28)} ${(st.progress_ms / 1000).toFixed(2).padStart(8)} s ` +
        `${Number.isNaN(residual) ? '      ·' : `${residual >= 0 ? '+' : ''}${residual.toFixed(0)} ms`.padStart(7)}  rtt ${rtt.toFixed(0)} ms${st.is_playing ? '' : '  (paused)'}`,
    );
  }
  await sleep(Math.max(0, intervalMs - (performance.now() - tickStart)));
}

console.log('\nSummary (deviation = reported position minus a steady clock fitted to the same play):');
for (const [device, s] of byDevice) {
  const abs = s.residuals.map(Math.abs).sort((a, b) => a - b);
  const pct = (p: number) => (abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))].toFixed(0) : '-');
  const sd = Math.sqrt(s.residuals.reduce((a, r) => a + r * r, 0) / Math.max(1, s.residuals.length));
  console.log(
    `  ${device}: ${s.residuals.length} samples, deviation sd ${sd.toFixed(0)} ms, p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms; ` +
      `round trip median ${median(s.rtts).toFixed(0)} ms; ${s.jumps} seeks/track changes`,
  );
}
process.exit(0);
