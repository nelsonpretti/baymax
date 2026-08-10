'use strict';
// Animation loop and mood logic. Decides what the robot should look like right
// now, then hands a plain description of it to src/robot.js to draw.

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let settings = null;

// --- inputs ---------------------------------------------------------------
let cursor = { dx: 0, dy: 0 };
let lastCursorMove = 0;
let cursorInside = false;
let speech = null;
let activity = { state: 'idle', at: 0 };
let transient = null;
let lastSpokeAt = 0;
let battery = 1;
// The microphone, while Fn+Shift holds it open.
let listen = { listening: false, at: 0, levels: [] };
// Claude Code's five-hour budget, mirrored by the statusline hook (main.js).
let limit = { used: null, resetsAt: null, at: 0 };

// True only when the budget is genuinely spent AND the refresh is still ahead of us.
// Nothing under 100 counts: a warning look would cry wolf for the last hour of every
// session, and the point of the sleeping face is that Claude cannot answer at all.
function atSessionLimit() {
  if (limit.used == null || limit.used < 100) return false;
  if (!limit.resetsAt) return false;
  return limit.resetsAt > Date.now() / 1000;
}

// "1h04m" while there is an hour left, "9m" in the last stretch. Short enough to sit
// inside the visor without shrinking the face.
function limitCountdown() {
  if (!limit.resetsAt) return '';
  const left = Math.max(0, limit.resetsAt - Math.floor(Date.now() / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// --- animated state -------------------------------------------------------
const anim = {
  gazeX: 0, gazeY: 0, turn: 0, tilt: 0, lid: 1,
  open: 0, jaw: 0.4, spread: 0.5, glow: 1,
  jump: 0, squash: 0, armLeft: 0, armRight: 0,
};

let blinkAt = performance.now() + 1200;
let blinkPhase = -1;
let waveUntil = 0;
let nextWaveAt = performance.now() + 30000;
let scratchUntil = 0;
let nextScratchAt = performance.now() + 12000;
let jumpStart = 0;
let displayIndex = 0;
let displaySwapAt = 0;
let idleMouth = 'smile';
let mouthSwapAt = performance.now() + 4000;

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Clicking the face pokes it. Poke it too often and it gets dizzy.
const POKES = ['wink', 'love', 'shocked'];
const DIZZY_AFTER = 6;          // clicks...
const DIZZY_WINDOW = 60000;     // ...within this long
let clickTimes = [];
let pokeIndex = 0;
let dizzyUntil = 0;      // no poke can interrupt a dizzy spell
let grumpyUntil = 0;     // and afterwards it is annoyed, until the window ends
let speakingUntil = 0;

const MOOD_COLOURS = {
  done: '#4ade80',
  error: '#f87171',
  annoyed: '#f87171',
  battery: '#f87171',
};

// What the visor shows while Claude is busy. Just the pulsing dots: the
// loading bar means "pulling something into context" and the question mark
// means "I am asking you something", so neither of those is plain work.
const WORKING_DISPLAYS = ['dots'];

// The canvas is the FACE's size, not the window's — the window grows sideways
// when the settings open and the face must not move or restretch.
function faceSize() {
  return {
    w: settings ? settings.width : window.innerWidth,
    h: settings ? settings.height : window.innerHeight,
  };
}

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = faceSize();
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gear = document.getElementById('gear');
  const panel = document.getElementById('panel');
  gear.style.left = (w - 34) + 'px';
  panel.style.left = (w + 10) + 'px';
}

// --- per-frame ------------------------------------------------------------
function updateGaze(now) {
  const moving = now - lastCursorMove < 900;
  const tx = moving ? clamp(cursor.dx * 1.6, -1, 1) : 0;
  const ty = moving ? clamp(cursor.dy * 1.4, -1, 1) : 0;
  anim.gazeX = lerp(anim.gazeX, tx, 0.10);
  anim.gazeY = lerp(anim.gazeY, ty, 0.10);
  // Yaw and pitch of the whole head. It holds the turn while you are moving
  // and for a beat afterwards, then eases back to facing front.
  const holding = now - lastCursorMove < 2000;
  anim.turn = lerp(anim.turn, holding ? clamp(cursor.dx * 1.4, -1, 1) : 0, 0.07);
  anim.tilt = lerp(anim.tilt, holding ? clamp(cursor.dy * 1.3, -1, 1) : 0, 0.07);
}

// Standing by, the eyes blink and drift but the mouth used to sit frozen open.
// It now drifts between the open smile and a closed line, on its own rhythm.
function updateIdleMouth(now) {
  if (now < mouthSwapAt) return;
  idleMouth = idleMouth === 'smile' ? 'flat' : 'smile';
  // Closed is the resting state and it holds for much longer; the open smile
  // is the occasional visitor.
  mouthSwapAt = now + (idleMouth === 'flat'
    ? 2600 + Math.random() * 3400
    : 1400 + Math.random() * 1800);
}

function updateBlink(now, mood) {
  if (mood === 'sleepy') { anim.lid = lerp(anim.lid, 1, 0.1); return; }
  if (blinkPhase < 0 && now >= blinkAt) blinkPhase = 0;
  if (blinkPhase >= 0) {
    blinkPhase += 1 / 60;
    const d = 0.26;      // long enough to actually see
    if (blinkPhase >= d) {
      blinkPhase = -1;
      anim.lid = 1;
      blinkAt = now + 1100 + Math.random() * 2200;
    } else {
      anim.lid = Math.abs(Math.cos((blinkPhase / d) * Math.PI));
    }
  }
}

function updateMouth() {
  let openT = 0, jawT = 0.4, spreadT = 0.5;
  if (speech) {
    // t0 is stamped when the daemon LAUNCHES the player, not when sound comes
    // out, so the mouth used to start moving while the audio device was still
    // opening. voiceLead holds the envelope back by that gap.
    const elapsed = Date.now() / 1000 - speech.t0 - (settings.voiceLead || 0);
    if (elapsed >= 0 && elapsed < speech.duration + 0.15) {
      const i = clamp(Math.floor(elapsed / speech.hop), 0, speech.loudness.length - 1);
      openT = speech.loudness[i];
      jawT = speech.jaw[i];
      spreadT = speech.spread[i];
      lastSpokeAt = performance.now();
    } else if (elapsed >= speech.duration + 0.15) {
      speech = null;
    }
  }
  anim.open = lerp(anim.open, openT, openT > anim.open ? 0.42 : 0.20);
  anim.jaw = lerp(anim.jaw, jawT, 0.26);
  anim.spread = lerp(anim.spread, spreadT, 0.26);
}

// A wave every 30 seconds when idle, and — while working — the occasional
// hand-to-chin scratch, so a long job doesn't look frozen.
function updateWave(now, mood) {
  const canWave = mood === 'calm' || mood === 'typing' || mood === 'sleepy';
  if (canWave && now > nextWaveAt) {
    waveUntil = now + 2000;
    nextWaveAt = now + 30000;
  }
  if ((mood === 'working' || mood === 'loading') && now > nextScratchAt) {
    scratchUntil = now + 2600;
    nextScratchAt = now + 14000 + Math.random() * 9000;
  }

}

// The rigged layers handle everything now — the arms really rotate — so the
// only reason to show a whole-artwork pose is a forced preview.
function currentPose(now, mood) {
  if (activity.state && activity.state.startsWith('pose:')) return activity.state.slice(5);
  if (now < scratchUntil && (mood === 'working' || mood === 'loading')) return 'think';
  if (now < waveUntil) return 'wave';
  return 'idle';
}

// Arm angles, in radians, at the shoulder. Positive swings the arm downward on
// the left and upward on the right, so each side gets its own sign.
function updateArms(now, mood) {
  const waving = now < waveUntil;
  const scratching = now < scratchUntil && (mood === 'working' || mood === 'loading');

  // A slow breathing sway so he is never completely still.
  const idleSway = Math.sin(now / 1500) * 0.035;

  let targetRight = idleSway;
  let targetLeft = -idleSway;

  if (waving) {
    // Raise the right arm and swing it back and forth.
    targetRight = -1.15 + Math.sin(now / 110) * 0.28;
  } else if (scratching) {
    // Bring the right hand up toward the chin and fidget.
    targetRight = -0.78 + Math.sin(now / 190) * 0.10;
  }

  anim.armRight = lerp(anim.armRight, targetRight, waving ? 0.20 : 0.10);
  anim.armLeft = lerp(anim.armLeft, targetLeft, 0.10);
}

// One hop, with a squash on take-off and landing.
function updateJump(now) {
  const t = (now - jumpStart) / 620;
  if (t < 0 || t > 1) { anim.jump = lerp(anim.jump, 0, 0.2); anim.squash = lerp(anim.squash, 0, 0.2); return; }
  anim.jump = Math.sin(t * Math.PI);
  anim.squash = t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 0;
}

function currentMood(now) {
  if (activity.state && activity.state.startsWith('force:')) return activity.state.slice(6);
  // Out of budget outranks everything except a forced preview — there is nothing the
  // robot could be doing, so any other mood would be a lie.
  if (atSessionLimit()) return 'limited';
  // Being spoken to outranks everything: the waveform is the proof the mic is
  // live, so it must not be elbowed aside by a mood or a tool call. Stale
  // levels are ignored in case the recorder dies without saying so.
  if (listen.listening && Date.now() / 1000 - listen.at < 2) return 'listening';
  if (transient && now < transient.until) return transient.mood;
  if (speech || now < speakingUntil) return 'speaking';
  // A busy state that stops being refreshed is stale — a hook can miss its
  // "idle" write and leave the visor stuck on the loading bar for ever.
  const busyFor = activity.at ? Date.now() / 1000 - activity.at : 0;
  const busy = busyFor < 25;
  if (activity.state === 'loading' && busy) return 'loading';
  if (activity.state === 'working' && busy) return 'working';
  if (activity.state === 'waiting') return 'waiting';
  if (activity.state === 'typing') return 'typing';
  const idleFor = now - Math.max(lastSpokeAt, activity.at * 1000);
  if (idleFor > 90000) return 'sleepy';
  return 'calm';
}

function workingDisplay(now) {
  if (battery < 0.20) return 'battery';
  if (now > displaySwapAt) {
    displaySwapAt = now + 6000;
    displayIndex = (displayIndex + 1) % WORKING_DISPLAYS.length;
  }
  return WORKING_DISPLAYS[displayIndex];
}

function lookFor(mood, now) {
  const base = {
    display: 'face',
    eyeShape: 'normal',
    mouthShape: 'smile',
    speaking: false,
    wink: false,
    zzz: false,
    wash: null,
    glow: 1,
  };

  switch (mood) {
    case 'speaking':
      return { ...base, speaking: true, glow: 1.15 };
    case 'listening': {
      // A forced preview has no microphone behind it, so give it something
      // moving rather than a dead flat line.
      const levels = listen.levels && listen.levels.length
        ? listen.levels
        : Array.from({ length: 24 }, (_, i) =>
          0.25 + 0.55 * Math.abs(Math.sin(now / 260 + i * 0.55)));
      return { ...base, display: 'wave', levels, glow: 1.3 };
    }
    case 'working':
      return { ...base, display: workingDisplay(now), glow: 0.9 + 0.3 * Math.sin(now / 300) };
    case 'waiting':
      return { ...base, display: 'question', glow: 1.1 };  // stays the default colour
    case 'loading':
      return { ...base, display: 'loading', glow: 1.0 };
    case 'done':
      return { ...base, eyeShape: 'happy', mouthShape: 'open',
        wash: '#4ade80', glow: 1.4 };
    case 'error':
      return { ...base, eyeShape: 'angry', mouthShape: 'frownArc',
        wash: '#f87171', glow: 1.3 };
    case 'wink':
      return { ...base, eyeShape: 'wink', mouthShape: 'grin', glow: 1.2 };
    case 'love':
      return { ...base, eyeShape: 'heart', mouthShape: 'grin', glow: 1.35 };
    case 'shocked':
      return { ...base, eyeShape: 'cross', mouthShape: 'oh', glow: 1.25 };
    case 'dizzy':
      return { ...base, eyeShape: 'spiral', mouthShape: 'blob', glow: 1.1 };
    case 'annoyed':
      return { ...base, eyeShape: 'angry', mouthShape: 'frownArc',
        wash: '#f87171', glow: 1.1 };
    case 'sleepy':
      return { ...base, eyeShape: 'sleepy', mouthShape: 'small', zzz: true, glow: 0.5 + 0.15 * Math.sin(now / 1600) };
    case 'limited':
      // The sleeping face, plus how long until it can work again.
      return { ...base, eyeShape: 'sleepy', mouthShape: 'small', zzz: true,
        corner: limitCountdown(), glow: 0.5 + 0.15 * Math.sin(now / 1600) };
    case 'battery':
      return { ...base, display: 'battery', wash: '#f87171' };
    case 'chart':
      return { ...base, display: 'chart' };
    case 'typing':
      return { ...base, mouthShape: idleMouth, glow: 1.05 };
    default:
      return { ...base, mouthShape: idleMouth };
  }
}

function frame() {
  const now = performance.now();
  const mood = currentMood(now);

  updateGaze(now);
  updateBlink(now, mood);
  updateIdleMouth(now);
  updateMouth();
  updateWave(now, mood);
  updateArms(now, mood);
  updateJump(now);

  const look = lookFor(mood, now);
  const accent = (settings.moodColours && MOOD_COLOURS[mood]) || settings.accentColor;
  anim.glow = lerp(anim.glow, look.glow, 0.12);

  const { w, h } = faceSize();
  ctx.clearRect(0, 0, w, h);
  if (settings.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(settings.bgColor, settings.bgOpacity);
    ctx.fillRect(0, 0, w, h);
  }

  window.Robot.draw(ctx, w, h, {
    ...look,
    accent,
    band: settings.bandColor,
    screen: settings.screenColor,
    chassis: settings.chassisColor,
    glow: anim.glow,
    lid: anim.lid,
    gazeX: anim.gazeX,
    gazeY: anim.gazeY,
    turn: anim.turn,
    tilt: anim.tilt,
    breath: now / 1600,
    jump: anim.jump,
    squash: anim.squash,
    battery,
    progress: (now / 2200) % 1,
    mouthW: 3 + 8 * anim.spread + 1.5 * anim.open,
    mouthH: 1 + 6 * anim.open * (0.25 + 0.75 * anim.jaw),
  });

  // Show where the window actually is while the mouse is over it.
  if (cursorInside) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    const r = 12, i = 1.5;
    ctx.beginPath();
    ctx.moveTo(i + r, i);
    ctx.arcTo(w - i, i, w - i, h - i, r);
    ctx.arcTo(w - i, h - i, i, h - i, r);
    ctx.arcTo(i, h - i, i, i, r);
    ctx.arcTo(i, i, w - i, i, r);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  requestAnimationFrame(frame);
}

// A poke cycles through the three reactions; enough pokes in a minute and it
// goes dizzy for five seconds instead.
function poke() {
  const now = performance.now();
  // Mid-spin, poking does nothing at all — the dizzy spell runs its full five
  // seconds however hard you jab at it.
  if (now < dizzyUntil) return;
  // And for the rest of the minute after it, poking just annoys it.
  if (now < grumpyUntil) {
    transient = { mood: 'annoyed', until: now + 1600 };
    return;
  }
  clickTimes = clickTimes.filter((t) => now - t < DIZZY_WINDOW);
  clickTimes.push(now);
  if (clickTimes.length >= DIZZY_AFTER) {
    clickTimes = [];
    dizzyUntil = now + 5000;
    grumpyUntil = now + DIZZY_WINDOW;
    transient = { mood: 'dizzy', until: dizzyUntil };
    return;
  }
  const mood = POKES[pokeIndex % POKES.length];
  pokeIndex += 1;
  transient = { mood, until: now + 1600 };
}

// Walk through every face the robot has, a few seconds each. Same list the
// parade script uses, but driven from the settings panel.
const DEMO = ['calm', 'listening', 'working', 'loading', 'waiting', 'done', 'error',
  'sleepy', 'battery', 'wink', 'love', 'shocked', 'dizzy', 'annoyed'];
let demoTimer = null;

function runDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  let i = 0;
  const step = () => {
    if (i >= DEMO.length) {
      clearInterval(demoTimer); demoTimer = null;
      transient = null;
      return;
    }
    transient = { mood: DEMO[i], until: performance.now() + 2600 };
    i += 1;
  };
  step();
  demoTimer = setInterval(step, 2500);
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// --- settings panel -------------------------------------------------------
const FIELDS = [
  ['accentColor', null],
  ['bandColor', null],
  ['screenColor', null],
  ['chassisColor', null],
  ['bgColor', null],
  ['bgOpacity', 'bgOpacityVal'],
  ['voiceLead', 'voiceLeadVal'],
  ['width', 'widthVal'],
  ['height', 'heightVal'],
];

function bindPanel() {
  const panel = document.getElementById('panel');
  const shell = document.getElementById('shell');
  document.getElementById('gear').addEventListener('click', () => {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    shell.classList.toggle('panel-open', open);
    // Measure the panel AFTER it is displayed and tell the main process how
    // tall the window has to be, or a short face crops the bottom controls.
    const top = parseFloat(getComputedStyle(panel).top) || 8;
    window.face.panel(open, open ? top * 2 + panel.offsetHeight : 0);
  });
  // Rebinding the recording shortcut. The button only ARMS the key listener —
  // the keys themselves are read there, because Fn produces no event a window
  // can see. The label comes back the same way.
  const hotkeyBtn = document.getElementById('hotkey');
  hotkeyBtn.addEventListener('click', async () => {
    hotkeyBtn.textContent = 'Press the new shortcut…';
    const ok = await window.face.captureHotkey();
    if (!ok) hotkeyBtn.textContent = 'Voice shortcut: unavailable';
  });
  window.face.onHotkey((d) => {
    hotkeyBtn.textContent = d.capturing
      ? 'Press the new shortcut…'
      : 'Voice shortcut: ' + (d.label || '?');
  });

  document.getElementById('resetColours').addEventListener('click', async () => {
    settings = await window.face.resetColours();
    // Put the panel's own controls back where the settings now are, or the
    // swatches keep showing the colours you just threw away.
    for (const [key, valId] of FIELDS) {
      const el = document.getElementById(key);
      el.value = settings[key];
      if (valId) document.getElementById(valId).textContent = settings[key];
    }
  });
  document.getElementById('demo').addEventListener('click', runDemo);
  document.getElementById('quit').addEventListener('click', () => window.face.quit());

  for (const [key, valId] of FIELDS) {
    const el = document.getElementById(key);
    el.value = settings[key];
    if (valId) document.getElementById(valId).textContent = settings[key];
    el.addEventListener('input', async () => {
      const v = el.type === 'color' ? el.value : Number(el.value);
      settings[key] = v;
      if (valId) document.getElementById(valId).textContent = v;
      await window.face.setSettings({ [key]: v });
    });
  }

  const moods = document.getElementById('moodColours');
  moods.checked = settings.moodColours;
  moods.addEventListener('change', async () => {
    settings.moodColours = moods.checked;
    await window.face.setSettings({ moodColours: moods.checked });
  });
}

// --- boot -----------------------------------------------------------------
(async function boot() {
  settings = await window.face.getSettings();
  await window.Robot.load();
  layout();
  bindPanel();

  window.face.onCursor((d) => {
    if (Math.abs(d.dx - cursor.dx) > 0.004 || Math.abs(d.dy - cursor.dy) > 0.004) {
      lastCursorMove = performance.now();
    }
    cursor = d;
    cursorInside = !!d.inside;
  });

  window.face.onSpeech((s) => {
    speech = s;
    // How long the audio will actually run. The mood logic holds the lip sync
    // for this whole span, so a tool call starting mid-sentence cannot yank
    // the visor over to the working dots while you are still hearing words.
    // The pad also has to cover voiceLead — playback starts that much after the
    // event lands, so the sentence finishes later than its duration suggests.
    speakingUntil = performance.now() + (s.duration || 0) * 1000
      + (settings.voiceLead || 0) * 1000 + 250;
    if (s.mood) {
      transient = { mood: s.mood, until: performance.now() + 3200 };
      if (s.mood === 'done') jumpStart = performance.now();
    }
    // No flash before the mouth starts: a face change here just delays the
    // first frame of speech and reads as lag.
  });

  window.face.onActivity((a) => {
    activity = a;
    if (a.state === 'done' || a.state === 'error') {
      transient = { mood: a.state, until: performance.now() + 3200 };
      if (a.state === 'done') jumpStart = performance.now();
    }
  });

  window.face.onListen((d) => { listen = d; });

  window.face.onBattery((level) => { battery = level; });

  window.face.onLimit((d) => { limit = d; });

  // The window was dragged: redraw at the new size and move the sliders to match,
  // so the panel never disagrees with what is on screen.
  window.face.onFaceSize(({ width, height }) => {
    settings.width = width;
    settings.height = height;
    layout();
    for (const [key, valId] of [['width', 'widthVal'], ['height', 'heightVal']]) {
      const el = document.getElementById(key);
      if (el) el.value = settings[key];
      const out = document.getElementById(valId);
      if (out) out.textContent = settings[key];
    }
  });

  // Dragging by hand, because the window is no longer an OS drag region — it
  // has to be able to tell a drag from a poke.
  let press = null;
  const shell = document.getElementById('shell');
  shell.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('#panel, #gear')) return;
    press = { x0: e.screenX, y0: e.screenY, sentX: 0, sentY: 0, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (!press) return;
    let tx = e.screenX - press.x0;
    let ty = e.screenY - press.y0;
    // A coalesced or stale first move can report a huge jump — the pointer did
    // not really travel 300px between the press and the next frame. Re-anchor
    // instead of hurling the window across the screen.
    if (!press.moved && Math.hypot(tx, ty) > 120) {
      press.x0 = e.screenX; press.y0 = e.screenY;
      return;
    }
    if (!press.moved && Math.hypot(tx, ty) < 4) return;
    press.moved = true;
    // Always relative to the press point, so a dropped event cannot drift.
    window.face.moveBy(tx - press.sentX, ty - press.sentY);
    press.sentX = tx; press.sentY = ty;
  });
  window.addEventListener('mouseup', () => {
    if (press && !press.moved) poke();
    press = null;
  });

  window.addEventListener('resize', layout);
  requestAnimationFrame(frame);
})();
