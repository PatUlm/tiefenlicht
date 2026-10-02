import { compileSong, STEP_SECONDS, type Drum, type Note, type Song, type Tone, type Voice } from './song.ts';

const STORAGE_KEY = 'dungeon.music';
/** Master level: background music, well below anything the game might add later. */
const VOLUME = 0.65;
const LOOKAHEAD_S = 0.3;
const TIMER_MS = 60;
/** Tracker arpeggio speed: one chord tone per tick. */
const ARP_TICK_S = 1 / 40;
/** Echo of a dotted eighth, as in many Amiga modules. */
const ECHO_S = STEP_SECONDS * 3;

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

function frequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Band-limited wave from one period of a waveform (Fourier coefficients by DFT). */
function periodicWave(ctx: BaseAudioContext, sample: (phase: number) => number, harmonics = 48): PeriodicWave {
  const n = 2048;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h++) {
    for (let i = 0; i < n; i++) {
      const x = sample(i / n);
      real[h]! += (x * Math.cos((2 * Math.PI * h * i) / n) * 2) / n;
      imag[h]! += (x * Math.sin((2 * Math.PI * h * i) / n) * 2) / n;
    }
  }
  return ctx.createPeriodicWave(real, imag);
}

/** NES-style triangle: 32 steps of 4-bit levels, which gives it its slight buzz. */
function steppedTriangle(phase: number): number {
  const i = Math.floor(phase * 32);
  const level = i < 16 ? 15 - i : i - 16;
  return level / 7.5 - 1;
}

/**
 * Synthesises the song (song.ts) on any audio context: four channels like a
 * tracker – pulse lead with a stereo echo, arpeggio, triangle bass, noise drums.
 */
export class ChipSynth {
  readonly output: GainNode;
  private readonly channels: Record<Voice | 'drums', GainNode>;
  private readonly waves: Record<Tone, PeriodicWave>;
  private readonly noise: AudioBuffer;

  constructor(private readonly ctx: BaseAudioContext) {
    this.output = ctx.createGain();
    // Soften the square waves a little and keep peaks in check.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 7000;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 3;
    lowpass.connect(compressor).connect(this.output);

    const echo = ctx.createDelay(1);
    echo.delayTime.value = ECHO_S;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const echoPan = ctx.createStereoPanner();
    echoPan.pan.value = 0.45;
    echo.connect(feedback).connect(echo);
    echo.connect(echoPan).connect(lowpass);

    // Gentle stereo spread (Amiga channels were hard-panned; this stays comfortable on headphones).
    const channel = (pan: number, send: number) => {
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner).connect(lowpass);
      if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        gain.connect(s).connect(echo);
      }
      return gain;
    };
    this.channels = { lead: channel(-0.15, 0.32), arp: channel(0.3, 0.22), bass: channel(0, 0), drums: channel(-0.05, 0) };

    this.waves = {
      pulse12: periodicWave(ctx, (p) => (p < 0.125 ? 1 : -1)),
      pulse25: periodicWave(ctx, (p) => (p < 0.25 ? 1 : -1)),
      pulse50: periodicWave(ctx, (p) => (p < 0.5 ? 1 : -1)),
      triangle: periodicWave(ctx, steppedTriangle),
    };
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  note(note: Note, t: number): void {
    const ctx = this.ctx;
    const length = note.steps * STEP_SECONDS;
    // Lead and arpeggio are played slightly detached, the bass legato.
    const end = t + length * (note.voice === 'bass' ? 0.97 : 0.88);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.waves[note.tone]);
    if (note.pitches.length === 1) {
      osc.frequency.setValueAtTime(frequency(note.pitches[0]!), t);
    } else {
      for (let k = 0, tt = t; tt < end; k++, tt += ARP_TICK_S) {
        osc.frequency.setValueAtTime(frequency(note.pitches[k % note.pitches.length]!), tt);
      }
    }
    const env = ctx.createGain();
    const sustain = note.gain * (note.voice === 'lead' ? 0.75 : 0.6);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(note.gain, t + 0.006);
    env.gain.exponentialRampToValueAtTime(sustain, t + 0.09);
    env.gain.setValueAtTime(sustain, end);
    env.gain.linearRampToValueAtTime(0, end + 0.04);
    osc.connect(env).connect(this.channels[note.voice]);

    // Delayed vibrato on long lead notes.
    if (note.voice === 'lead' && note.steps >= 4) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(0, t + 0.2);
      depth.gain.linearRampToValueAtTime(frequency(note.pitches[0]!) * 0.006, t + 0.45);
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(end + 0.05);
    }
    osc.onended = () => env.disconnect();
    osc.start(t);
    osc.stop(end + 0.05);
  }

  drum(drum: Drum, t: number): void {
    const ctx = this.ctx;
    const out = this.channels.drums;
    const env = (peak: number, decay: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      g.connect(out);
      return g;
    };
    const noise = (filter: BiquadFilterType, hz: number, peak: number, decay: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = filter;
      f.frequency.value = hz;
      src.connect(f).connect(env(peak, decay));
      src.start(t, Math.random() * 0.5);
      src.stop(t + decay);
    };
    const thump = (fromHz: number, toHz: number, peak: number, decay: number) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(this.waves.triangle);
      osc.frequency.setValueAtTime(fromHz, t);
      osc.frequency.exponentialRampToValueAtTime(toHz, t + decay * 0.7);
      osc.connect(env(peak, decay));
      osc.start(t);
      osc.stop(t + decay);
    };
    if (drum === 'kick') thump(150, 45, 0.5, 0.16);
    else if (drum === 'snare') {
      noise('bandpass', 1800, 0.3, 0.14);
      thump(200, 120, 0.16, 0.07);
    } else noise('highpass', 7000, 0.07, 0.035);
  }
}

/**
 * Background music: plays the song in a loop with a look-ahead scheduler.
 * Browsers allow audio only after a user gesture, so playback starts with the
 * first one. On/off is remembered; a hidden tab suspends the audio.
 */
export class Music {
  private ctx: AudioContext | null = null;
  private synth: ChipSynth | null = null;
  private readonly song: Song = compileSong();
  private step = 0;
  private nextTime = 0;
  private timer: number | undefined;
  private suspendTimer: number | undefined;
  private on = loadEnabled();
  private readonly listeners = new Set<(on: boolean) => void>();

  constructor() {
    const unlock = () => {
      for (const type of ['click', 'keydown', 'touchend'] as const) window.removeEventListener(type, unlock, true);
      if (this.on) this.play();
    };
    for (const type of ['click', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else if (this.on) void this.ctx.resume();
    });
  }

  get enabled(): boolean {
    return this.on;
  }

  onChange(listener: (on: boolean) => void): void {
    this.listeners.add(listener);
  }

  toggle(): void {
    this.on = !this.on;
    saveEnabled(this.on);
    if (this.on) this.play();
    else this.pause();
    for (const listener of this.listeners) listener(this.on);
  }

  private play(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.synth = new ChipSynth(this.ctx);
      this.synth.output.gain.value = 0;
      this.synth.output.connect(this.ctx.destination);
    }
    const ctx = this.ctx;
    window.clearTimeout(this.suspendTimer);
    void ctx.resume();
    const gain = this.synth!.output.gain;
    gain.cancelScheduledValues(ctx.currentTime);
    gain.setValueAtTime(gain.value, ctx.currentTime);
    gain.linearRampToValueAtTime(VOLUME, ctx.currentTime + 1.2);
    if (this.timer === undefined) {
      this.nextTime = ctx.currentTime + 0.1;
      this.timer = window.setInterval(() => this.schedule(), TIMER_MS);
    }
  }

  private pause(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const gain = this.synth!.output.gain;
    gain.cancelScheduledValues(ctx.currentTime);
    gain.setValueAtTime(gain.value, ctx.currentTime);
    gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    this.suspendTimer = window.setTimeout(() => void ctx.suspend(), 350);
  }

  private schedule(): void {
    const ctx = this.ctx!;
    if (ctx.state !== 'running') return;
    // After a stall (throttled timer) skip ahead instead of firing a burst of old notes.
    if (this.nextTime < ctx.currentTime) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      const step = this.song.steps[this.step]!;
      for (const note of step.notes) this.synth!.note(note, this.nextTime);
      for (const drum of step.drums) this.synth!.drum(drum, this.nextTime);
      this.nextTime += STEP_SECONDS;
      this.step = this.step + 1 < this.song.steps.length ? this.step + 1 : this.song.loopStart;
    }
  }
}
