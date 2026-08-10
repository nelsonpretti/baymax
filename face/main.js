'use strict';
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { analyze } = require('./src/wav');

const VOICE_EVENT = '/tmp/voice-face-event';
const ACTIVITY_STATE = '/tmp/claude-face-state';
// bin/voice-global.py publishes how loud you are while Fn+Shift has the
// microphone open, so the visor can show it back to you.
const LISTEN_STATE = '/tmp/claude-face-listen';
// Rebinding the recording shortcut. The key listener owns it — Fn never reaches
// an ordinary window — so this end just asks and then reads back the answer.
const HOTKEY_CAPTURE = '/tmp/voice-hotkey-capture';
const HOTKEY_STATE = '/tmp/voice-hotkey-state';
// Claude Code's five-hour budget, mirrored by the statusline hook. When it is
// spent the robot goes to sleep and counts down to the refresh.
const LIMIT_STATE = '/tmp/claude-session-limit';

const DEFAULTS = {
  accentColor: '#85f7ff',   // eyes and mouth, glowing on the dark visor
  bandColor: '#2f5aa4',     // the blue ring around the visor
  screenColor: '#0e203a',
  chassisColor: '#c2d0e1',
  moodColours: true,
  bgColor: '#000000',
  bgOpacity: 0,
  // Seconds between the voice daemon announcing a clip and the sound actually
  // reaching your ears — afplay has to open the audio device first, and the
  // mouth used to start moving during that gap. See the "Voice delay" slider;
  // scripts/measure_audio_lead.py can hear the beep but cannot separate its own
  // recorder start-up from afplay's, so the last word is your ear, not a probe.
  voiceLead: 0.15,
  width: 300,
  height: 360,
};

// Words that tell the face how a sentence is going. Checked against the text
// the voice daemon is about to speak.
const GOOD = /\b(done|finished|fixed|works|working now|verified|passed|ready|complete|success|great)\b/i;
const BAD = /\b(error|failed|failing|broken|crash|cannot|can't|blocked|wrong|bug)\b/i;

let win = null;
let settingsPath = null;
let settings = { ...DEFAULTS };

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('settings save failed:', e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: settings.width,
    height: settings.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[face]', msg));
  win.loadFile('index.html');
  win.on('closed', () => { win = null; });
}

function startCursorPolling() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const disp = screen.getDisplayNearestPoint(pt).workAreaSize;
    win.webContents.send('cursor', {
      dx: (pt.x - (b.x + b.width / 2)) / (disp.width / 2),
      dy: (pt.y - (b.y + b.height / 2)) / (disp.height / 2),
      // CSS :hover does not fire reliably on a transparent always-on-top
      // window, so the outline is driven from the real cursor position.
      inside: pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height,
    });
  }, 50);
}

// The voice daemon announces each sentence the moment playback starts. We
// analyse the same wav for the mouth and read its text for the mood.
function startVoiceWatch() {
  let lastSeen = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let raw;
    try { raw = fs.readFileSync(VOICE_EVENT, 'utf8'); } catch { return; }
    if (raw === lastSeen || !raw.trim()) return;
    lastSeen = raw;

    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (!evt.path || !fs.existsSync(evt.path)) return;

    const env = analyze(evt.path);
    if (!env) return;

    let mood = null;
    if (evt.text) {
      if (BAD.test(evt.text)) mood = 'error';
      else if (GOOD.test(evt.text)) mood = 'done';
    }
    console.log(`speech ${env.duration.toFixed(2)}s${mood ? ' mood ' + mood : ''}`);
    win.webContents.send('speech', { ...env, t0: evt.t0, mood });
  }, 60);
}

// Claude Code writes what it is doing here (see hooks/claude-face-state.sh).
function startActivityWatch() {
  let lastSeen = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let raw;
    try { raw = fs.readFileSync(ACTIVITY_STATE, 'utf8'); } catch { return; }
    if (raw === lastSeen || !raw.trim()) return;
    lastSeen = raw;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (!evt.state) return;
    console.log(`activity ${evt.state}`);
    win.webContents.send('activity', { state: evt.state, at: evt.at || Date.now() / 1000 });
  }, 200);
}

// The microphone levels, polled fast enough that the bars move with your voice
// rather than lagging behind it.
function startListenWatch() {
  let lastSeen = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let raw;
    try { raw = fs.readFileSync(LISTEN_STATE, 'utf8'); } catch { return; }
    if (raw === lastSeen || !raw.trim()) return;
    lastSeen = raw;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    win.webContents.send('listen', {
      listening: !!evt.listening,
      at: evt.at || Date.now() / 1000,
      levels: Array.isArray(evt.levels) ? evt.levels : [],
    });
  }, 40);
}

function startHotkeyWatch() {
  let lastSeen = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let raw;
    try { raw = fs.readFileSync(HOTKEY_STATE, 'utf8'); } catch { return; }
    if (raw === lastSeen || !raw.trim()) return;
    lastSeen = raw;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    win.webContents.send('hotkey', {
      label: evt.label || '',
      capturing: !!evt.capturing,
    });
  }, 200);
}

// The five-hour budget. Polled slowly — it only moves when the statusline redraws,
// and the countdown itself is worked out in the renderer from resets_at.
function startLimitWatch() {
  let lastSeen = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let raw;
    try { raw = fs.readFileSync(LIMIT_STATE, 'utf8'); } catch { return; }
    if (raw === lastSeen || !raw.trim()) return;
    lastSeen = raw;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    win.webContents.send('limit', {
      used: evt.used_percentage == null ? null : Number(evt.used_percentage),
      resetsAt: evt.resets_at == null ? null : Number(evt.resets_at),
      at: evt.at || Date.now() / 1000,
    });
  }, 2000);
}

ipcMain.handle('capture-hotkey', () => {
  try {
    fs.writeFileSync(HOTKEY_CAPTURE, '1');
    return true;
  } catch {
    return false;
  }
});

// Real machine battery, so the robot can show a battery when yours is low.
function startBatteryPolling() {
  const { execFile } = require('child_process');
  const read = () => {
    execFile('pmset', ['-g', 'batt'], (err, out) => {
      if (err || !win || win.isDestroyed()) return;
      const m = out.match(/(\d+)%/);
      if (!m) return;
      win.webContents.send('battery', Number(m[1]) / 100);
    });
  };
  read();
  setInterval(read, 60000);
}

// Every setting that is a colour. Size and the mood-colour switch are not, so a
// reset leaves the window where you put it.
const COLOUR_KEYS = ['accentColor', 'bandColor', 'screenColor', 'chassisColor',
  'bgColor', 'bgOpacity'];

ipcMain.handle('get-settings', () => settings);

ipcMain.handle('reset-colours', () => {
  for (const key of COLOUR_KEYS) settings[key] = DEFAULTS[key];
  saveSettings();
  return settings;
});

ipcMain.handle('set-settings', (_e, next) => {
  settings = { ...settings, ...next };
  saveSettings();
  if (win && !win.isDestroyed() && (next.width || next.height)) {
    win.setSize(Math.round(settings.width), Math.round(settings.height));
  }
  return settings;
});

// The settings panel lives in a strip to the RIGHT of the face, so the window
// grows while it is open rather than the panel covering the robot.
// The panel lives in a strip to the RIGHT of the face, so the window grows
// while it is open rather than the panel covering the robot. It also has to
// grow TALL enough: the renderer measures the panel and sends its real height,
// because a fixed number silently clipped the bottom controls off whenever the
// panel gained a row or the face was set short.
const PANEL_STRIP = 232;
ipcMain.on('panel', (_e, open, needed) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  const w = settings.width + (open ? PANEL_STRIP : 0);
  const h = open
    ? Math.max(settings.height, Math.ceil(needed || 430))
    : settings.height;
  win.setBounds({ x, y, width: w, height: h });
});

ipcMain.on('move-by', (_e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.on('quit', () => app.quit());

app.whenReady().then(() => {
  loadSettings();
  console.log('settings', JSON.stringify(settings));
  createWindow();
  startCursorPolling();
  startVoiceWatch();
  startActivityWatch();
  startListenWatch();
  startHotkeyWatch();
  startLimitWatch();
  startBatteryPolling();
});

app.on('window-all-closed', () => app.quit());
