// Draws the robot's head as vector shapes, matched to Nelson's reference
// picture: a pale periwinkle helmet with a royal-blue ring around a dark navy
// visor, small ear pods either side, and a short neck stub underneath.
//
// This is deliberately drawn rather than cut out of the reference photo. The
// cut-out gave a ragged, colour-contaminated outline that never cleaned up, and
// it could only be swapped between fixed pictures. Drawn, the outline is
// perfect at any size and every part can actually move.
//
// GEOMETRY is in "reference pixels" — the coordinate system of the source
// picture, origin at the centre of the helmet — and scaled to the window at
// draw time. Every number below was measured off the reference, not guessed.

const REF = {
  // The helmet is not a symmetric rounded box: it is a broad dome on top that
  // tapers to a narrower chin, so its top and bottom corner radii differ.
  head: { hw: 87, top: -72, bottom: 73, rTop: 75, rBottom: 46 },
  // A stubby drum: its root sits right at the skull surface (the head is 87
  // wide here) so the tube stays short instead of running deep into the head.
  // Two constraints pin the root. It must sit inside the skull with a margin
  // — the head is 87 wide at the ear's middle but only 85 at its top edge, and
  // parking the root exactly on the surface let a gap open at shallow turn
  // angles and the ear floated free. And it must stop outside the blue ring,
  // whose outer edge is at 76, or the tube paints across the head all the way
  // to the visor and the ear reads as long and fused to it. 80 clears both.
  // cz stays 0: off the mid-plane it hangs beside the skull, not on it.
  pod: { inner: 80, outer: 94, cy: 10, cz: 0, r: 24 },
  ring: { hw: 76, top: -41, bottom: 59, rTop: 42, rBottom: 45 },
  visor: { hw: 70, top: -31, bottom: 51, rTop: 30, rBottom: 42 },
  neck: { hw: 41, top: 58, bottom: 80, r: 6 },
  eye: { dx: 32, base: 9, hw: 10, h: 11 },
  mouth: { top: 19, bottom: 32, hw: 9.5 },
  // Reference pixels per "cell" of the talking mouth. The mouth used to be
  // pixel art on a 19-cell grid; keeping its scale keeps the vowel shapes as
  // big and as readable as they were.
  mouthCell: 3.83,
  // How far in front of the turning axis each layer sits. This is what makes
  // the head read as a solid object when it turns rather than a flat sticker.
  depth: { pod: -12, shell: 0, visor: 32, face: 45 },
  boxW: 212, boxH: 155, boxCY: 4,
  // the head is nearly as deep as it is wide, and the faceplate sits this far
  // forward of its centre
  depthRatio: 0.90, faceZ: 38,
  // viewing distance, reference pixels — sets how strong the perspective is
  // Viewing distance. Short distances blow the ear outwards as the head turns,
  // until it sits on the rear silhouette edge instead of in the middle of the
  // visible side. Far away, cos(yaw) is free to carry it inwards where an ear
  // actually goes.
  dist: 1500,
};

// The visor's displays glow by their own cell size (the visor is 19 cells
// wide), and the face now uses the identical figure so every lit thing on the
// screen has the same halo. In reference pixels, per unit of `glow`.
const GLOW_BLUR = (REF.visor.hw * 2 / 19) * 1.6;

const YAW_MAX = 0.58;   // radians at full cursor deflection (~33 degrees)
const PITCH_MAX = 0.34;

// Kept for the mood-preview scripts; the face itself is vector now.
const EYES = {
  normal: 'dome', happy: 'arc', sleepy: 'droop',
  wide: 'oval', angry: 'angry', squint: 'squint',
  wink: 'wink', heart: 'heart', cross: 'cross', spiral: 'spiral',
};
const MOUTHS = { smile: 1, flat: 1, frown: 1, small: 1 };

async function load() { /* nothing to load — it is all drawn */ }

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// A rounded shape whose top and bottom corners can differ — the helmet, the
// ring and the visor are all this shape, and none of them is symmetric.
function blobPath(ctx, hw, top, bottom, rTop, rBottom) {
  ctx.beginPath();
  blobSub(ctx, hw, top, bottom, rTop, rBottom);
}

// The same shape added to whatever path is already open, so the helmet and the
// ears can be one path and therefore one silhouette.
function blobSub(ctx, hw, top, bottom, rTop, rBottom) {
  const rt = Math.min(rTop, hw, (bottom - top) / 2);
  const rb = Math.min(rBottom, hw, (bottom - top) / 2);
  ctx.moveTo(0, top);
  ctx.arcTo(hw, top, hw, bottom, rt);
  ctx.arcTo(hw, bottom, -hw, bottom, rb);
  ctx.arcTo(-hw, bottom, -hw, top, rb);
  ctx.arcTo(-hw, top, 0, top, rt);
  ctx.closePath();
}

// --- the eyes -------------------------------------------------------------
// A dome: rounded on top, cut flat along the bottom. That is the reference
// eye, and every other mood is a variation on it.
function eyePath(ctx, cx, cy, hw, hh, shape) {
  const base = cy + hh / 2;
  const top = cy - hh / 2;
  ctx.beginPath();
  switch (shape) {
    case 'arc': {          // happy — an upward crescent
      ctx.moveTo(cx - hw, base);
      ctx.quadraticCurveTo(cx, top - hh * 0.5, cx + hw, base);
      ctx.quadraticCurveTo(cx, top + hh * 0.35, cx - hw, base);
      break;
    }
    case 'droop': {        // sleepy — the crescent turned over
      ctx.moveTo(cx - hw, top);
      ctx.quadraticCurveTo(cx, base + hh * 0.5, cx + hw, top);
      ctx.quadraticCurveTo(cx, base - hh * 0.35, cx - hw, top);
      break;
    }
    case 'oval':           // startled — a full round eye
      ctx.ellipse(cx, cy, hw * 0.92, hh * 0.92, 0, 0, Math.PI * 2);
      break;
    case 'squint':
      roundRect(ctx, cx - hw, cy - hh * 0.22, hw * 2, hh * 0.44, hh * 0.22);
      break;
    case 'angry':          // handled as a stroked brow in drawSpecialEye
      break;
    default: {             // dome
      ctx.moveTo(cx - hw, base);
      ctx.lineTo(cx - hw, base - hh * 0.34);
      ctx.bezierCurveTo(cx - hw, top - hh * 0.42, cx + hw, top - hh * 0.42,
        cx + hw, base - hh * 0.34);
      ctx.lineTo(cx + hw, base);
      break;
    }
  }
  ctx.closePath();
}

// The faces that react to a click, plus the dizzy spirals. Returns true when
// it has drawn the eye itself, false to fall through to the ordinary shapes.
function drawSpecialEye(ctx, shape, dir, hw, hh, look, k) {
  const lw = Math.max(1.6, 2.6 * k);
  switch (shape) {
    case 'wink': {
      if (dir < 0) {                       // the open eye: a round pupil
        ctx.beginPath();
        ctx.arc(0, 0, hh * 0.46, 0, Math.PI * 2);
        ctx.fill();
      } else {                             // the winking eye: a soft chevron
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(hw * 0.55, -hh * 0.45);
        ctx.lineTo(-hw * 0.45, 0);
        ctx.lineTo(hw * 0.55, hh * 0.45);
        ctx.stroke();
      }
      return true;
    }
    case 'angry': {
      // A thick brow angled down towards the nose, like the reference.
      // dir -1 is the left eye, so its OUTER side is negative x.
      const outer = dir * hw, inner = -dir * hw;
      ctx.lineWidth = Math.max(2.4, 4.4 * k);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(outer, -hh * 0.45);
      ctx.quadraticCurveTo(0, -hh * 0.05, inner, hh * 0.55);
      ctx.stroke();
      return true;
    }
    case 'heart': {
      const w = hw * 1.15, h = hh * 1.15;
      ctx.beginPath();
      ctx.moveTo(0, h * 0.52);
      ctx.bezierCurveTo(-w * 1.15, -h * 0.15, -w * 0.5, -h * 0.95, 0, -h * 0.30);
      ctx.bezierCurveTo(w * 0.5, -h * 0.95, w * 1.15, -h * 0.15, 0, h * 0.52);
      ctx.closePath();
      ctx.fill();
      return true;
    }
    case 'cross': {
      const r = Math.min(hw, hh) * 0.85;
      ctx.lineWidth = lw * 1.15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-r, -r); ctx.lineTo(r, r);
      ctx.moveTo(r, -r); ctx.lineTo(-r, r);
      ctx.stroke();
      return true;
    }
    case 'spiral': {
      // Slowly turning, and the two eyes wind opposite ways so it reads dizzy
      // rather than mechanical.
      const turns = 2.6;
      const rMax = Math.min(hw, hh) * 1.05;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const phase = look.progress * Math.PI * 2 * dir;
      for (let i = 0; i <= 90; i++) {
        const t = (i / 90) * turns * Math.PI * 2;
        const r = (t / (turns * Math.PI * 2)) * rMax;
        const a = t * dir + phase;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      return true;
    }
    default:
      return false;
  }
}

// --- the mouth ------------------------------------------------------------
// The reference mouth is a filled tongue: a wide rounded top narrowing to a
// soft point. `flip` turns it into a frown.
function tonguePath(ctx, cx, top, bottom, hw, flip) {
  const y0 = flip ? bottom : top;
  const y1 = flip ? top : bottom;
  const h = y1 - y0;
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.74, y0);
  ctx.quadraticCurveTo(cx - hw, y0, cx - hw, y0 + h * 0.22);
  ctx.bezierCurveTo(cx - hw * 0.95, y0 + h * 0.72, cx - hw * 0.52, y1,
    cx - hw * 0.16, y1);
  ctx.quadraticCurveTo(cx, y1 + h * 0.06, cx + hw * 0.16, y1);
  ctx.bezierCurveTo(cx + hw * 0.52, y1, cx + hw * 0.95, y0 + h * 0.72,
    cx + hw, y0 + h * 0.22);
  ctx.quadraticCurveTo(cx + hw, y0, cx + hw * 0.74, y0);
  ctx.closePath();
}

// The talking mouth. Width comes from the second vocal-tract resonance and
// height from the first, so "ee" renders wide and flat and "oh" small and
// round — that distinction is the whole point of src/wav.js.
function livePath(ctx, cx, cy, hw, hh) {
  const w = Math.max(3, hw);
  const h = Math.max(1.6, hh);
  roundRect(ctx, cx - w, cy - h, w * 2, h * 2, Math.min(w, h) * 0.92);
}

// --- the visor display ----------------------------------------------------
function drawDisplay(ctx, look, box) {
  const { x: sx, y: sy, w: sw, h: sh } = box;
  const px = sw / 19;
  const cx = sx + sw / 2;
  ctx.fillStyle = look.accent;
  ctx.strokeStyle = look.accent;
  ctx.shadowColor = look.accent;
  ctx.shadowBlur = px * 1.6 * look.glow;

  switch (look.display) {
    case 'loading': {
      const bw = sw * 0.62, bh = sh * 0.20;
      const bx = cx - bw / 2, by = sy + sh / 2 - bh / 2;
      ctx.lineWidth = Math.max(1.5, px * 0.5);
      roundRect(ctx, bx, by, bw, bh, bh * 0.45);
      ctx.stroke();
      const pad = px * 0.55;
      const inner = bw - pad * 2;
      roundRect(ctx, bx + pad, by + pad, Math.max(pad, inner * look.progress),
        bh - pad * 2, (bh - pad * 2) * 0.45);
      ctx.fill();
      // A brighter head sweeping ahead of the fill, so it always looks busy.
      const headX = bx + pad + inner * look.progress;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(headX - px * 0.4, by + pad, px * 0.8, bh - pad * 2);
      ctx.globalAlpha = 1;
      return;
    }
    case 'question': {
      // A slow rock from side to side, the way you tilt your head waiting for
      // an answer. Same colour as the face — nothing here is an alarm.
      const tilt = Math.sin(look.progress * Math.PI * 2) * 0.20;
      ctx.save();
      ctx.translate(cx, sy + sh * 0.52);
      ctx.rotate(tilt);
      ctx.font = `bold ${sh * 0.70}px "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 0);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
      return;
    }
    case 'battery': {
      // Big, and honestly low — a sliver of charge in a wide cell.
      const bw = sw * 0.62, bh = sh * 0.46;
      const bx = cx - bw / 2, by = sy + sh / 2 - bh / 2;
      ctx.lineWidth = Math.max(2, px * 0.72);
      roundRect(ctx, bx, by, bw, bh, bh * 0.26);
      ctx.stroke();
      roundRect(ctx, bx + bw + px * 0.35, by + bh * 0.30, px * 1.0, bh * 0.40, px * 0.4);
      ctx.fill();
      const pad = px * 0.7;
      const inner = bw - pad * 2;
      const level = Math.max(0.16, Math.min(0.3, look.battery));
      roundRect(ctx, bx + pad, by + pad, inner * level, bh - pad * 2, px * 0.35);
      ctx.fill();
      return;
    }
    case 'chart': {
      const bars = 8;
      const base = sy + sh * 0.78;
      for (let i = 0; i < bars; i++) {
        const t = (look.progress * 2.2 + i / bars) % 1;
        const bh2 = sh * (0.10 + 0.46 * Math.abs(Math.sin(t * Math.PI)));
        ctx.fillRect(sx + sw * (0.16 + i * 0.093), base - bh2, px * 1.4, bh2);
      }
      return;
    }
    case 'wave': {
      // What you are saying, while the microphone is open. The point is
      // reassurance — it has to move with your voice, so the bars are the real
      // input levels, newest on the right, and a flat line means silence
      // rather than a frozen display.
      const levels = look.levels && look.levels.length ? look.levels : [0];
      const n = Math.min(levels.length, 24);
      const mid = sy + sh * 0.5;
      const gap = (sw * 0.82) / n;
      // Bars have to stay narrower than the space between them, or a loud
      // moment fuses them into one solid block instead of reading as a wave.
      const bw = Math.max(1.4, gap * 0.40);
      const x0 = cx - (gap * (n - 1)) / 2;
      ctx.lineCap = 'round';
      ctx.lineWidth = bw;
      for (let i = 0; i < n; i++) {
        const v = levels[levels.length - n + i] || 0;
        const half = Math.max(bw * 0.5, sh * 0.32 * Math.min(1, v));
        const x = x0 + gap * i;
        ctx.beginPath();
        ctx.moveTo(x, mid - half);
        ctx.lineTo(x, mid + half);
        ctx.stroke();
      }
      return;
    }
    case 'dots':
      for (let i = 0; i < 3; i++) {
        const t = (look.progress * 2 + i * 0.25) % 1;
        ctx.globalAlpha = 0.28 + 0.72 * Math.sin(t * Math.PI);
        ctx.fillRect(cx + (i - 1) * px * 3.4 - px, sy + sh * 0.5 - px, px * 2.1, px * 2.1);
      }
      ctx.globalAlpha = 1;
      return;
    default:
      break;
  }
}

// The face itself, drawn in reference pixels with the origin at the helmet
// centre. `k` scales reference pixels to canvas pixels.
function drawFace(ctx, look, k) {
  const e = REF.eye;
  ctx.fillStyle = look.accent;
  ctx.strokeStyle = look.accent;
  ctx.shadowColor = look.accent;
  // The same halo the loading bar and the dots carry. The face used to glow a
  // quarter as hard, so standing by and talking looked flat next to a robot
  // that was merely busy.
  ctx.shadowBlur = GLOW_BLUR * k * look.glow;

  const gx = look.gazeX * 4 * k;
  const gy = look.gazeY * 3 * k;
  // Map the mood's eye NAME to the shape it draws. Comparing the name against
  // shape names is how blinking quietly died: 'normal' never equalled 'dome',
  // so the lid scale was skipped and the eyes never closed.
  const shape = EYES[look.eyeShape] || 'dome';

  for (const dir of [-1, 1]) {
    const cx = dir * e.dx * k + gx;
    const cy = (e.base - e.h / 2) * k + gy;
    ctx.save();
    ctx.translate(cx, cy);
    // A blink squashes the eye, but only shapes that are really eyelids —
    // a spiral or a cross has nothing to close.
    if (shape === 'dome' || shape === 'arc' || shape === 'oval') {
      ctx.scale(1, Math.max(0.06, look.lid));
    }
    if (!drawSpecialEye(ctx, shape, dir, e.hw * k, e.h * k, look, k)) {
      eyePath(ctx, 0, 0, e.hw * k, e.h * k, shape);
      ctx.fill();
    }
    ctx.restore();
  }

  const m = REF.mouth;
  const mx = gx * 0.7;
  if (look.speaking) {
    // mouthW/mouthH arrive in grid cells; REF.mouthCell converts them back to
    // the size the pixel mouth used to be.
    const c = REF.mouthCell * k;
    livePath(ctx, mx, (m.top + m.bottom) / 2 * k + gy * 0.6,
      look.mouthW * c / 2, look.mouthH * c / 2);
    ctx.fill();
  } else if (look.mouthShape === 'flat') {
    roundRect(ctx, mx - m.hw * 0.8 * k, (m.top + 4) * k + gy * 0.6,
      m.hw * 1.6 * k, 3.2 * k, 1.6 * k);
    ctx.fill();
  } else if (look.mouthShape === 'grin') {
    // a wide open arc, for the love face
    const w = m.hw * 1.5 * k, y = (m.top + 2) * k + gy * 0.6;
    ctx.lineWidth = Math.max(1.8, 3.0 * k);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mx - w, y);
    ctx.quadraticCurveTo(mx, y + m.hw * 2.0 * k, mx + w, y);
    ctx.stroke();
  } else if (look.mouthShape === 'open') {
    // a filled half-disc: flat along the top, round underneath
    const w = m.hw * 1.6 * k, y = (m.top + 1) * k + gy * 0.6;
    ctx.beginPath();
    ctx.moveTo(mx - w, y);
    ctx.lineTo(mx + w, y);
    ctx.arc(mx, y, w, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
  } else if (look.mouthShape === 'frownArc') {
    const w = m.hw * 1.25 * k, y = (m.top + 11) * k + gy * 0.6;
    ctx.lineWidth = Math.max(1.8, 3.2 * k);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mx - w, y);
    ctx.quadraticCurveTo(mx, y - m.hw * 1.5 * k, mx + w, y);
    ctx.stroke();
  } else if (look.mouthShape === 'oh') {
    livePath(ctx, mx, (m.top + 7) * k + gy * 0.6, 7.5 * k, 7.5 * k);
    ctx.fill();
  } else if (look.mouthShape === 'blob') {
    roundRect(ctx, mx - m.hw * 0.9 * k, m.top * k + gy * 0.6,
      m.hw * 2.0 * k, 10 * k, 3.5 * k);
    ctx.fill();
  } else if (look.mouthShape === 'small') {
    livePath(ctx, mx, (m.top + 6) * k + gy * 0.6, 4 * k, 4 * k);
    ctx.fill();
  } else {
    tonguePath(ctx, mx, (m.top * k) + gy * 0.6, (m.bottom * k) + gy * 0.6,
      m.hw * k, look.mouthShape === 'frown');
    ctx.fill();
  }

  if (look.zzz) {
    ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const t = (look.progress + i * 0.33) % 1;
      const size = (15 + i * 7) * k;      // they grow as they float away
      ctx.font = `bold ${size}px "SF Mono", Menlo, monospace`;
      ctx.globalAlpha = 0.30 + 0.70 * Math.sin(t * Math.PI);
      ctx.fillText('z', (34 + i * 11) * k, (4 - t * 30 - i * 9) * k);
    }
    ctx.globalAlpha = 1;
  }
  ctx.shadowBlur = 0;
}

// The helmet's vertical gradient. The ears share it so they cannot look like
// a different material.
function shellGrad(ctx, k, shell) {
  const g = ctx.createLinearGradient(0, REF.head.top * k, 0, REF.head.bottom * k);
  g.addColorStop(0, shade(shell, 0.09));
  g.addColorStop(1, shade(shell, -0.09));
  return g;
}


// --- an ear -----------------------------------------------------------------
// Earlier versions faked this: a 2D shape whose width was stretched by a
// formula. It never held up — the ear popped off the side of the head as it
// turned, and the far ear behaved like a mirror of the near one instead of
// receding. So the ear is now an actual cylinder: 3D points, rotated by the
// same yaw and pitch as the head, projected with perspective, and drawn as a
// shaded tube. Attachment and occlusion then come out right by construction.

const LIGHT = (() => {
  const v = [-0.42, -0.55, 0.72];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

// Rotate by yaw about the vertical axis, then pitch about the horizontal one,
// and project. Positive z is towards the viewer.
// The nod happens FIRST, about the head's own ear-to-ear axis, and the turn
// second. Doing it the other way round tips the ear axis into a diagonal
// across the head — a real head nods about the line through its ears, so the
// ears themselves never leave the horizontal.
function rotateDir(x, y, z, yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Y = y * cp - z * sp;
  const z1 = y * sp + z * cp;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [x * cy + z1 * sy, Y, -x * sy + z1 * cy];
}

function project(x, y, z, yaw, pitch) {
  const [X, Y, Z] = rotateDir(x, y, z, yaw, pitch);
  const s = REF.dist / (REF.dist - Z);
  return { x: X * s, y: Y * s, z: Z, s };
}

const EAR_SEGMENTS = 60;

// The head is a SOLID, and the ear's root is buried inside it. Anything inboard
// of the skull's surface must therefore not be painted, whichever order the two
// ears happen to be drawn in.
//
// This is what made the two ears look different facing forward. The far ear was
// drawn, the skull repainted over it, then the near ear drawn last — so the near
// ear's buried section (from the root at 80 out to the skull's edge at 87) sat
// as a slab across the shell while the other ear's was covered up. On a head
// facing straight at you there is no near and no far, so the two must be
// identical, and they only are once the burial is decided by depth.
//
// The skull is treated as an ellipsoid the width of the helmet and nearly as
// deep — the same approximation the silhouette already relies on.
function headSolid(nx, ny) {
  const hd = REF.head;
  return {
    a: hd.hw * nx,
    b: (hd.bottom - hd.top) / 2 * ny,
    cy: (hd.top + hd.bottom) / 2 * ny,
    c: hd.hw * REF.depthRatio,
  };
}

function buriedInHead(q, head) {
  const u = q.x / head.a, v = (q.y - head.cy) / head.b;
  const d = 1 - u * u - v * v;
  return d > 0 && q.z < head.c * Math.sqrt(d);
}

// How far out along the tube the ear leaves the skull. Facing forward this
// lands on the helmet's own edge, so the visible stub is exactly as long on
// both sides; as the head turns it creeps back towards the root, which is
// what uncovers more of the near ear's base.
function emergeAt(dir, y, z, yaw, pitch, head, lo, hi) {
  const at = (t) => buriedInHead(project(dir * t, y, z, yaw, pitch), head);
  if (!at(lo)) return lo;
  if (at(hi)) return hi;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

// The ear's rim rings, in projected space. `inset` shrinks it, which is how
// the single silhouette gets its outline: the whole union is filled once in
// the outline colour and once, slightly smaller, in the shell colour.
// With `head` supplied each ring starts where it clears the skull instead of at
// the buried root; the silhouette path passes nothing and keeps the full ear,
// because the union with the head covers the difference anyway.
function earRim(dir, yaw, pitch, inset, head) {
  const p = REF.pod;
  const r = Math.max(1, p.r - inset);
  const root = p.inner + inset * 0.4;
  const xOut = dir * (p.outer - inset);
  const rim = [];
  for (let i = 0; i <= EAR_SEGMENTS; i++) {
    const u = (i / EAR_SEGMENTS) * Math.PI * 2;
    const ny = Math.sin(u), nz = Math.cos(u);
    const y = p.cy + r * ny, z = p.cz + r * nz;
    const xIn = dir * (head
      ? emergeAt(dir, y, z, yaw, pitch, head, root, p.outer - inset)
      : root);
    rim.push({
      a: project(xIn, y, z, yaw, pitch),
      b: project(xOut, y, z, yaw, pitch),
      n: rotateDir(0, ny, nz, yaw, pitch),
      buried: head ? xIn !== dir * root : false,
    });
  }
  return rim;
}

// Add the ear's outline to the open path, as quads and caps all wound the same
// way so a nonzero fill unions them instead of punching holes.
function earSub(ctx, k, dir, yaw, pitch, inset) {
  const rim = earRim(dir, yaw, pitch, inset);
  const add = (pts) => {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i], r = pts[(i + 1) % pts.length];
      area += q.x * r.y - r.x * q.y;
    }
    const seq = area < 0 ? pts.slice().reverse() : pts;
    seq.forEach((q, i) => (i ? ctx.lineTo(q.x * k, q.y * k)
      : ctx.moveTo(q.x * k, q.y * k)));
    ctx.closePath();
  };
  for (let i = 0; i < EAR_SEGMENTS; i++) {
    add([rim[i].a, rim[i + 1].a, rim[i + 1].b, rim[i].b]);
  }
  add(rim.slice(0, EAR_SEGMENTS).map((q) => q.a));
  add(rim.slice(0, EAR_SEGMENTS).map((q) => q.b));
}

function drawEar(ctx, k, dir, shell, ring, yaw, pitch, inset, head) {
  const rim = earRim(dir, yaw, pitch, inset, head);
  const [, , faceZ] = rotateDir(dir, 0, 0, yaw, pitch);
  // The root is inside the skull, so its lid is never a surface you can see.
  const rootBuried = rim.some((q) => q.buried);

  // Every surface of the ear — the two end caps, the tube quads and the blue
  // rim arcs — goes into ONE list, sorted back to front and painted in that
  // order. Drawing the caps separately left the cylinder open at whichever end
  // pointed away, so you could see its own back wall and the far half of the
  // blue ring straight through it.
  const faces = [];

  const capPath = (key) => () => {
    ctx.beginPath();
    rim.forEach((q, i) => (i ? ctx.lineTo(q[key].x * k, q[key].y * k)
      : ctx.moveTo(q[key].x * k, q[key].y * k)));
    ctx.closePath();
  };

  // The lids are pinned to the extremes of the sort rather than their own
  // average depth. Face on, both ends of the tube sit at exactly the same
  // depth, the ordering between them becomes arbitrary, and the dark inner lid
  // lands on top — which reads as looking straight through the ear.
  const FRONT = 1e6;
  if (faceZ > 0) {
    const lit = Math.max(0, dir * LIGHT[0] * Math.cos(yaw) + faceZ * LIGHT[2]);
    faces.push({
      z: FRONT,
      draw: () => {
        capPath('b')();
        ctx.fillStyle = shade(shell, -0.03 + 0.12 * lit);
        ctx.fill();
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      },
    });
  } else if (!rootBuried) {
    // the buried end seals the tube when the outer lid faces away
    faces.push({
      z: -FRONT,
      draw: () => {
        capPath('a')();
        ctx.fillStyle = shade(shell, -0.30);
        ctx.fill();
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      },
    });
  }

  for (let i = 0; i < EAR_SEGMENTS; i++) {
    const q0 = rim[i], q1 = rim[i + 1];
    const nx = (q0.n[0] + q1.n[0]) / 2;
    const ny = (q0.n[1] + q1.n[1]) / 2;
    const nz = (q0.n[2] + q1.n[2]) / 2;
    const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const tone = -0.22 + 0.28 * lit;
    faces.push({
      z: (q0.a.z + q1.a.z + q0.b.z + q1.b.z) / 4,
      draw: () => {
        ctx.beginPath();
        ctx.moveTo(q0.a.x * k, q0.a.y * k);
        ctx.lineTo(q1.a.x * k, q1.a.y * k);
        ctx.lineTo(q1.b.x * k, q1.b.y * k);
        ctx.lineTo(q0.b.x * k, q0.b.y * k);
        ctx.closePath();
        // Darkest where it leaves the head, so the join stays readable
        // without turning into a seam.
        const g = ctx.createLinearGradient(
          (q0.a.x + q1.a.x) / 2 * k, (q0.a.y + q1.a.y) / 2 * k,
          (q0.b.x + q1.b.x) / 2 * k, (q0.b.y + q1.b.y) / 2 * k);
        g.addColorStop(0, shade(shell, tone - 0.20));
        g.addColorStop(0.30, shade(shell, tone - 0.04));
        g.addColorStop(1, shade(shell, tone));
        ctx.fillStyle = g;
        ctx.fill();
        // hairline overdraw, or the seams between quads show as light threads
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      },
    });

    // The blue rim arc for this segment. When the lid is facing you the whole
    // ring is its visible boundary, so it goes on last in one piece — sorting
    // the arcs individually against the tube left the ring dashed.
    faces.push({
      z: faceZ > 0 ? FRONT + 1
        : ((q0.n[2] + q1.n[2]) / 2 > 0 ? (q0.b.z + q1.b.z) / 2 + 0.4 : -FRONT - 1),
      draw: () => {
        ctx.strokeStyle = ring;
        ctx.lineWidth = Math.max(1.5, 3.2 * k);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(q0.b.x * k, q0.b.y * k);
        ctx.lineTo(q1.b.x * k, q1.b.y * k);
        ctx.stroke();
      },
    });
  }

  faces.sort((u, v) => u.z - v.z);
  faces.forEach((f) => f.draw());
}

// --- the head -------------------------------------------------------------
function draw(ctx, w, h, look) {
  ctx.clearRect(0, 0, w, h);

  const k = Math.min((w * 0.94) / REF.boxW, (h * 0.94) / REF.boxH);
  const shell = look.chassis;
  const ring = look.band;

  const yaw = (look.turn || 0) * YAW_MAX;
  // negative: cursor below the window means the head nods DOWN, which moves
  // the faceplate down the screen and shows more of the crown
  const pitch = -(look.tilt || 0) * PITCH_MAX;
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // A round head barely changes width when it turns — it is a ball, not a
  // card. Squeezing it by cos(yaw) was what made the whole thing read as flat
  // and left the ears looking bolted on behind it. The real change is this
  // small, and everything else comes from the faceplate moving across it.
  const nx = Math.sqrt(cy * cy + (REF.depthRatio * sy_) ** 2);
  const ny = Math.sqrt(cp * cp + (0.95 * sp) ** 2);

  ctx.save();
  ctx.translate(w / 2, h / 2 - REF.boxCY * k - (look.jump || 0) * 12 * k);
  ctx.translate(0, Math.sin(look.breath) * 2.6 * k);
  const hd = REF.head;
  const OUTLINE = 1.7;   // reference px of shared outline around the whole body

  // The helmet and the two ears are ONE silhouette, not three shapes stacked
  // up. Everything goes into a single path and gets filled twice — once in the
  // outline colour, once slightly smaller in the shell colour — so a single
  // continuous outline runs round the whole body and there is no seam where an
  // ear meets the head.
  const earDepth = (dir) => -dir * REF.pod.inner * Math.sin(yaw);
  const bodyPath = (inset) => {
    ctx.beginPath();
    blobSub(ctx, (hd.hw * nx - inset) * k, (hd.top * ny + inset) * k,
      (hd.bottom * ny - inset) * k, hd.rTop * nx * k, hd.rBottom * nx * k);
    earSub(ctx, k, -1, yaw, pitch, inset);
    earSub(ctx, k, +1, yaw, pitch, inset);
  };

  // --- neck stub, behind the body ---
  const n = REF.neck;
  ctx.save();
  ctx.scale(nx, ny);
  ctx.fillStyle = look.screen;
  roundRect(ctx, -n.hw * k, n.top * k, n.hw * 2 * k, (n.bottom - n.top) * k, n.r * k);
  ctx.fill();
  ctx.strokeStyle = shade(shell, -0.10);
  ctx.lineWidth = Math.max(1, 2.2 * k);
  ctx.stroke();
  ctx.restore();

  // --- the body: outline, then fill ---
  bodyPath(0);
  ctx.fillStyle = shade(shell, -0.22);
  ctx.fill('nonzero');
  bodyPath(OUTLINE);
  ctx.fillStyle = shellGrad(ctx, k, shell);
  ctx.fill('nonzero');

  const headShape = () => blobPath(ctx, hd.hw * nx * k, hd.top * ny * k,
    hd.bottom * ny * k, hd.rTop * nx * k, hd.rBottom * nx * k);
  const headInset = () => blobPath(ctx, (hd.hw * nx - OUTLINE) * k,
    (hd.top * ny + OUTLINE) * k, (hd.bottom * ny - OUTLINE) * k,
    hd.rTop * nx * k, hd.rBottom * nx * k);

  // The ears' own cylindrical shading, with the skull painted back in between
  // them: the ear turning away is BEHIND the head and its buried section must
  // not show as a band lying across the face. Merging everything into one
  // silhouette had quietly thrown that ordering away.
  const solid = headSolid(nx, ny);
  const earOrder = [-1, 1].sort((a, b) => earDepth(a) - earDepth(b));
  drawEar(ctx, k, earOrder[0], shell, ring, yaw, pitch, OUTLINE, solid);
  headInset();
  ctx.fillStyle = shellGrad(ctx, k, shell);
  ctx.fill();
  drawEar(ctx, k, earOrder[1], shell, ring, yaw, pitch, OUTLINE, solid);

  // Volume shading over the whole body, so the ears are lit by the same lamp
  // as the shell they grow out of rather than looking like separate parts.
  ctx.save();
  bodyPath(OUTLINE);
  ctx.clip('nonzero');
  const hw2 = hd.hw, hh2 = (hd.bottom - hd.top) / 2;
  const midY = (hd.top + hd.bottom) / 2;
  const box = () => ctx.fillRect(-REF.boxW * k, -REF.boxH * k,
    REF.boxW * 2 * k, REF.boxH * 2 * k);

  // limb darkening: the shell turns away from you towards its own rim
  const limb = ctx.createRadialGradient(0, midY * k, hw2 * 0.30 * k,
    0, midY * k, hw2 * 1.06 * k);
  limb.addColorStop(0, 'rgba(28,46,84,0)');
  limb.addColorStop(0.62, 'rgba(28,46,84,0.05)');
  limb.addColorStop(1, 'rgba(28,46,84,0.34)');
  ctx.fillStyle = limb;
  box();

  // the key light, which slides across as the head turns
  const hlx = (-(look.turn || 0) * 0.50 - 0.24) * hw2 * k;
  const hly = (midY + (-(look.tilt || 0) * 0.34 - 0.44) * hh2) * k;
  const gl = ctx.createRadialGradient(hlx, hly, 2 * k, hlx, hly, hw2 * 1.05 * k);
  gl.addColorStop(0, 'rgba(255,255,255,0.52)');
  gl.addColorStop(0.55, 'rgba(255,255,255,0.13)');
  gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  box();

  // a rim light down the receding side, so the far edge lifts off the dark
  const rx = ((look.turn || 0) * 0.86 + 0.02) * hw2 * k;
  const rl = ctx.createRadialGradient(rx, midY * k, hw2 * 0.55 * k,
    rx, midY * k, hw2 * 1.02 * k);
  rl.addColorStop(0, 'rgba(255,255,255,0)');
  rl.addColorStop(1, 'rgba(255,255,255,0.20)');
  ctx.fillStyle = rl;
  box();

  // the shadow the ear casts on the side of the head
  for (const dir of [-1, 1]) {
    const root = project(dir * REF.pod.inner, REF.pod.cy, REF.pod.cz, yaw, pitch);
    const rs = REF.pod.r * 1.75;
    const sh = ctx.createRadialGradient(root.x * k, root.y * k,
      REF.pod.r * 0.55 * k, root.x * k, root.y * k, rs * k);
    sh.addColorStop(0, 'rgba(22,38,72,0.34)');
    sh.addColorStop(0.6, 'rgba(22,38,72,0.15)');
    sh.addColorStop(1, 'rgba(22,38,72,0)');
    ctx.fillStyle = sh;
    ctx.fillRect((root.x - rs) * k, (root.y - rs) * k, rs * 2 * k, rs * 2 * k);
  }
  ctx.restore();

  // --- blue ring and visor: a flat plate on the front of the head ---
  // Its centre is projected in 3D, and the plate itself foreshortens as it
  // rotates away from you, which is what a real faceplate does.
  const r = REF.ring;
  const plateCY = (r.top + r.bottom) / 2;
  const pc = project(0, plateCY, REF.faceZ, yaw, pitch);
  ctx.save();
  // A faceplate cannot poke outside the skull, however far the head turns.
  headShape();
  ctx.clip();
  ctx.translate(pc.x * k, pc.y * k);
  ctx.scale(cy * pc.s, cp * pc.s);
  ctx.translate(0, -plateCY * k);
  const ringGrad = ctx.createLinearGradient(0, r.top * k, 0, r.bottom * k);
  ringGrad.addColorStop(0, shade(ring, 0.16));
  ringGrad.addColorStop(1, shade(ring, -0.14));
  ctx.fillStyle = ringGrad;
  blobPath(ctx, r.hw * k, r.top * k, r.bottom * k, r.rTop * k, r.rBottom * k);
  ctx.fill();

  // --- visor ---
  const v = REF.visor;
  const vx = -v.hw * k, vy = v.top * k;
  const vw = v.hw * 2 * k, vh = (v.bottom - v.top) * k;
  ctx.save();
  blobPath(ctx, v.hw * k, v.top * k, v.bottom * k, v.rTop * k, v.rBottom * k);
  ctx.fillStyle = look.screen;
  ctx.fill();
  ctx.clip();

  ctx.fillStyle = 'rgba(255,255,255,0.018)';
  for (let y = vy; y < vy + vh; y += Math.max(2, 3.4 * k)) {
    ctx.fillRect(vx, y, vw, Math.max(1, 1.1 * k));
  }

  // A mood wash: the visor itself glows, so a low battery or a job well done
  // reads from across the room, not just from the eyes.
  if (look.wash) {
    const wg = ctx.createRadialGradient(0, (v.top + v.bottom) / 2 * k, 2 * k,
      0, (v.top + v.bottom) / 2 * k, v.hw * 1.1 * k);
    wg.addColorStop(0, hexA(look.wash, 0.46));
    wg.addColorStop(0.55, hexA(look.wash, 0.20));
    wg.addColorStop(1, hexA(look.wash, 0));
    ctx.fillStyle = wg;
    ctx.fillRect(vx, vy, vw, vh);
  }

  if (look.display && look.display !== 'face') {
    drawDisplay(ctx, look, { x: vx, y: vy, w: vw, h: vh });
    ctx.shadowBlur = 0;
  } else {
    drawFace(ctx, look, k);
  }

  // A small readout in the bottom-right of the visor — currently the countdown to the
  // session refresh while the robot is asleep out of budget. Drawn inside the visor
  // clip so it can never spill onto the helmet.
  if (look.corner) {
    ctx.save();
    const size = Math.max(7, 9.5 * k);
    ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = look.accent;
    ctx.shadowBlur = GLOW_BLUR * k * 0.5;
    ctx.fillStyle = look.accent;
    ctx.globalAlpha = 0.85;
    // The visor's bottom corners are heavily rounded (rBottom is 42 reference px), so
    // the inset has to clear the curve or the last character is sliced off.
    ctx.fillText(look.corner, vx + vw - 15 * k, vy + vh - 9 * k);
    ctx.restore();
  }

  // glass
  const gloss = ctx.createLinearGradient(vx, vy, vx + vw * 0.6, vy + vh * 0.7);
  gloss.addColorStop(0, 'rgba(255,255,255,0.10)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(vx, vy, vw, vh);
  ctx.restore();   // visor clip
  ctx.restore();   // faceplate

  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex, amount) {
  const n = parseInt(String(hex).slice(1), 16);
  const f = (v) => {
    const x = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(x)));
  };
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

window.Robot = { draw, load, EYES, MOUTHS, REF };
