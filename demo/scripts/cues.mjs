// Original, deterministic sound effects. No score, samples, or external assets.
import { mkdirSync, writeFileSync } from "node:fs";
const rate = 48000;
const samples = new Float32Array(rate * 30);
let seed = 73;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};
function cue(at, duration, kind) {
  let low = 0;
  for (let i = 0; i < duration * rate; i++) {
    const t = i / rate;
    const p = t / duration;
    low = low * 0.87 + noise() * 0.13;
    const envelope =
      kind === "air"
        ? Math.sin(Math.PI * p) ** 2
        : Math.exp(-p * 9) * Math.min(1, t * 1500);
    const sound =
      kind === "air"
        ? low * 0.24
        : Math.sin(2 * Math.PI * (750 * t - 800 * t * t)) * 0.11 + low * 0.15;
    const index = Math.round(at * rate) + i;
    if (index < samples.length) samples[index] += sound * envelope;
  }
}
for (const at of [0.04, 1, 12, 16, 20, 22, 27.7, 29]) cue(at, 0.2, "air");
for (const at of [
  2.25, 3.85, 7.55, 9.38, 10.26, 14.16, 16.2, 18.25, 24.35, 25.68,
])
  cue(at, 0.065, "tap");
const out = Buffer.alloc(44 + samples.length * 2);
out.write("RIFF");
out.writeUInt32LE(out.length - 8, 4);
out.write("WAVEfmt ", 8);
out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20);
out.writeUInt16LE(1, 22);
out.writeUInt32LE(rate, 24);
out.writeUInt32LE(rate * 2, 28);
out.writeUInt16LE(2, 32);
out.writeUInt16LE(16, 34);
out.write("data", 36);
out.writeUInt32LE(samples.length * 2, 40);
for (let i = 0; i < samples.length; i++)
  out.writeInt16LE(
    Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767),
    44 + i * 2,
  );
mkdirSync("public", { recursive: true });
writeFileSync("public/score.wav", out);
