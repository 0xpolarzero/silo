import { mkdirSync, writeFileSync } from "node:fs";
// Original procedural score. No samples, external services, or licensed assets.
const rate = 24000,
  seconds = 57,
  count = rate * seconds;
const pcm = Buffer.alloc(count * 4);
const chords = [
  [146.832, 220, 293.665, 349.228],
  [130.813, 196, 261.626, 329.628],
  [174.614, 220, 261.626, 349.228],
  [130.813, 196, 293.665, 391.995],
];
const beat = 0.5;
for (let i = 0; i < count; i++) {
  const t = i / rate;
  const chordIndex = Math.floor(t / (beat * 16));
  const chord = chords[chordIndex % chords.length];
  const within = t % (beat * 16);
  const blend = Math.min(1, within / 1.2);
  const prior = chords[(chordIndex + 3) % chords.length];
  let left = 0,
    right = 0;
  for (let n = 0; n < 4; n++) {
    const amp = 0.012 * (1 + 0.12 * Math.sin(t * 0.7 + n));
    left +=
      amp *
      (Math.sin(2 * Math.PI * chord[n] * t) * blend +
        Math.sin(2 * Math.PI * prior[n] * t) * (1 - blend));
    right +=
      amp *
      (Math.sin(2 * Math.PI * chord[n] * t + 0.1 * n) * blend +
        Math.sin(2 * Math.PI * prior[n] * t + 0.1 * n) * (1 - blend));
  }
  const tick = t % beat,
    note = chord[Math.floor(t / beat) % 4] * 2;
  const pluck = Math.sin(2 * Math.PI * note * t) * Math.exp(-tick * 11) * 0.021;
  const kickTime = t % (beat * 2);
  const kick =
    Math.sin(
      2 * Math.PI * (48 * kickTime + 7 * (1 - Math.exp(-kickTime * 28))),
    ) *
    Math.exp(-kickTime * 18) *
    0.031;
  const fade = Math.min(1, t / 3, (seconds - t) / 5);
  pcm.writeInt16LE(
    Math.round(Math.tanh((left + pluck + kick) * fade * 4) * 32767),
    i * 4,
  );
  pcm.writeInt16LE(
    Math.round(Math.tanh((right + pluck * 0.85 + kick) * fade * 4) * 32767),
    i * 4 + 2,
  );
}
const header = Buffer.alloc(44);
header.write("RIFF");
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
mkdirSync("public", { recursive: true });
writeFileSync("public/score.wav", Buffer.concat([header, pcm]));
console.log("Generated original 57-second stereo score.");
