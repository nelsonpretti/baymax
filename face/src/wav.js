'use strict';
// Minimal WAV reader + vowel analysis.
//
// The mouth needs three continuous drivers per frame:
//   loudness — how much sound there is (gates the whole mouth)
//   jaw      — how far the jaw is down. Tracks the first formant: the lower
//              resonance of the vocal tract rises as the mouth opens.
//   spread   — how spread versus rounded the lips are. Tracks the second
//              formant, which is high for "ee" and low for "oh"/"oo".
//
// Together these separate the vowels that a single loudness envelope cannot:
// "oh" comes out small and round, "ee" wide and thin, "ah" wide and open.

const fs = require('fs');

const HOP = 1 / 60;
const FFT_SIZE = 1024;

// --- WAV ------------------------------------------------------------------
function readChunks(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  const out = {};
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    out[id] = { start: off + 8, size };
    off += 8 + size + (size % 2);
  }
  return out;
}

function decode(path) {
  const buf = fs.readFileSync(path);
  const chunks = readChunks(buf);
  if (!chunks || !chunks['fmt '] || !chunks.data) return null;

  const f = chunks['fmt '].start;
  const format = buf.readUInt16LE(f);
  const channels = buf.readUInt16LE(f + 2);
  const sampleRate = buf.readUInt32LE(f + 4);
  const bits = buf.readUInt16LE(f + 14);

  const d = chunks.data.start;
  const end = Math.min(d + chunks.data.size, buf.length);
  const frameBytes = (bits / 8) * channels;
  const n = Math.floor((end - d) / frameBytes);
  const mono = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const o = d + i * frameBytes;
    if (format === 3 && bits === 32) mono[i] = buf.readFloatLE(o);
    else if (format === 1 && bits === 16) mono[i] = buf.readInt16LE(o) / 32768;
    else if (format === 1 && bits === 32) mono[i] = buf.readInt32LE(o) / 2147483648;
    else if (format === 1 && bits === 8) mono[i] = (buf.readUInt8(o) - 128) / 128;
    else return null;
  }
  return { samples: mono, sampleRate };
}

// --- FFT (in-place, radix-2) ----------------------------------------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

// Strongest resonance inside a band, smoothed over three bins so it does not
// hop between neighbouring harmonics. Measured on real Kokoro speech, this
// separates the vowels clearly: an "oh" clip sits around 1310 Hz in the upper
// band, an "ee" clip around 2180 Hz (see scripts/probe_formants.js).
function bandPeak(env, binHz, loHz, hiHz) {
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(env.length - 1, Math.ceil(hiHz / binHz));
  let best = -1, bestHz = (loHz + hiHz) / 2;
  for (let i = lo; i <= hi; i++) {
    if (env[i] > best) { best = env[i]; bestHz = i * binHz; }
  }
  return bestHz;
}

// Smooth the spectrum over a window wider than the gap between pitch
// harmonics, so the peak found is the resonance of the mouth and not whichever
// harmonic of the voice happens to be loudest.
function envelope(mag, out, halfWidth) {
  let sum = 0;
  for (let i = 0; i <= halfWidth && i < mag.length; i++) sum += mag[i];
  for (let i = 0; i < mag.length; i++) {
    const add = i + halfWidth;
    const drop = i - halfWidth - 1;
    if (i > 0) {
      if (add < mag.length) sum += mag[add];
      if (drop >= 0) sum -= mag[drop];
    }
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(mag.length - 1, i + halfWidth);
    out[i] = sum / (hi - lo + 1);
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function analyze(path) {
  const audio = decode(path);
  if (!audio || audio.samples.length === 0) return null;

  const { samples, sampleRate } = audio;
  const binHz = sampleRate / FFT_SIZE;
  const hopN = Math.max(1, Math.round(HOP * sampleRate));
  const count = Math.max(1, Math.floor(samples.length / hopN));

  const rms = new Float32Array(count);
  const jawRaw = new Float32Array(count);
  const spreadRaw = new Float32Array(count);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(FFT_SIZE / 2);
  const env = new Float64Array(FFT_SIZE / 2);
  // Kokoro's voice sits near 200 Hz, so smooth over roughly 280 Hz.
  const halfWidth = Math.max(2, Math.round(140 / binHz));

  // Consonants carry no vowel shape, so quiet and hissy frames hold the last
  // good lip position rather than throwing the mouth around.
  let lastJaw = 0.35, lastSpread = 0.35;

  for (let f = 0; f < count; f++) {
    const start = f * hopN;

    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      const x = idx < samples.length ? samples[idx] : 0;
      sum += x * x;
      re[i] = x * HANN[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sum / FFT_SIZE);

    if (rms[f] < 0.02) {
      jawRaw[f] = lastJaw;
      spreadRaw[f] = lastSpread;
      continue;
    }

    fft(re, im);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]);

    let lowE = 0, lowN = 0, highE = 0, highN = 0;
    for (let i = 0; i < mag.length; i++) {
      const hz = i * binHz;
      if (hz < 1000) { lowE += mag[i]; lowN++; }
      else if (hz > 3800) { highE += mag[i]; highN++; }
    }
    if (highE / (highN || 1) > 0.55 * (lowE / (lowN || 1))) {
      jawRaw[f] = lastJaw;
      spreadRaw[f] = lastSpread;
      continue;
    }

    envelope(mag, env, halfWidth);
    // Speech energy falls off with frequency, which drags every peak search
    // toward the bottom of its band. Tilting the envelope back up cancels that.
    for (let i = 1; i < env.length; i++) env[i] *= i * binHz;

    const f1 = bandPeak(env, binHz, 300, 950);
    const f2 = bandPeak(env, binHz, 950, 2900);

    lastJaw = clamp01((f1 - 240) / (800 - 240));
    lastSpread = clamp01((f2 - 1100) / (2300 - 1100));
    jawRaw[f] = lastJaw;
    spreadRaw[f] = lastSpread;
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || 1e-6;

  const loudness = new Float32Array(count);
  const jaw = new Float32Array(count);
  const spread = new Float32Array(count);

  // Formant estimates are noisy frame to frame; a short running average keeps
  // the lip shape moving smoothly without lagging the syllable.
  let jAcc = 0.4, sAcc = 0.5;
  for (let i = 0; i < count; i++) {
    loudness[i] = Math.min(1, Math.pow(rms[i] / loud, 0.95));
    const w = 0.35;
    jAcc += (jawRaw[i] - jAcc) * w;
    sAcc += (spreadRaw[i] - sAcc) * w;
    jaw[i] = jAcc;
    spread[i] = sAcc;
  }

  return {
    hop: HOP,
    duration: samples.length / sampleRate,
    loudness: Array.from(loudness),
    jaw: Array.from(jaw),
    spread: Array.from(spread),
  };
}

module.exports = { analyze, HOP };
