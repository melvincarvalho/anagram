// Notification sounds, synthesised in code.
import * as store from '../store.js';

// Synthesised in code, no audio files: soft bells with a quiet overtone. Browsers keep
// an AudioContext silent until the page has been touched, so it is created and resumed
// on the first gesture rather than on the first message.
let audio;
function primeAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch {}
}
addEventListener('pointerdown', primeAudio, { capture: true, passive: true });
addEventListener('keydown', primeAudio, { capture: true, passive: true });

// One bell note: fast attack, exponential decay, optional octave overtone that fades sooner.
function note(ctx, at, freq, { length = 0.3, peak = 0.15, overtone = 0.2 } = {}) {
  const play = (f, g, len) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(g, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + len + 0.02);
  };
  play(freq, peak, length);
  if (overtone) play(freq * 2, peak * overtone, length * 0.5);
}
const SOUNDS = {
  // Direct message: two rising notes, A5 then E6.
  dm: (ctx, t) => {
    note(ctx, t, 880);
    note(ctx, t + 0.09, 1318.5, { length: 0.34 });
  },
  // Room message or mention: one lower note, E5.
  room: (ctx, t) => note(ctx, t, 659.25, { length: 0.22, peak: 0.12 }),
  // Sent: a short falling tick, C6 to G5, quieter.
  sent: (ctx, t) => {
    note(ctx, t, 1046.5, { length: 0.07, peak: 0.07, overtone: 0 });
    note(ctx, t + 0.05, 784, { length: 0.09, peak: 0.06, overtone: 0 });
  },
};
export function playSound(name, { force = false } = {}) {
  if (!force && !store.notifySettings.value.sound) return;
  try {
    primeAudio();
    if (!audio || audio.state !== 'running') return;
    SOUNDS[name](audio, audio.currentTime);
  } catch {}
}
