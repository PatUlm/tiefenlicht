/**
 * Background theme "Das Gewölbe der Laternen": an original chiptune in D minor,
 * written like a four-channel tracker module (pulse lead, arpeggio, triangle bass,
 * noise drums). Pure data; music.ts synthesises it.
 *
 * Form: intro, then a loop of A (theme), B (brighter, in F), A again (sparser)
 * and C (a quiet, mysterious bridge). Intro and bridge have no drums, and the
 * arpeggio rests in parts of the loop so it does not tire over many repeats.
 */

export const BPM = 96;
export const STEPS_PER_BAR = 16;
/** Seconds per step (a sixteenth note). */
export const STEP_SECONDS = 60 / BPM / 4;

export type Tone = 'pulse12' | 'pulse25' | 'pulse50' | 'triangle';
export type Voice = 'lead' | 'arp' | 'bass';
export type Drum = 'kick' | 'snare' | 'hat';

export interface Note {
  readonly voice: Voice;
  readonly tone: Tone;
  /** MIDI pitches; several are cycled rapidly (tracker arpeggio). */
  readonly pitches: readonly number[];
  readonly steps: number;
  readonly gain: number;
}

export interface Step {
  readonly notes: readonly Note[];
  readonly drums: readonly Drum[];
}

export interface Song {
  readonly steps: readonly Step[];
  /** Where the timeline continues after its last step (the intro plays once). */
  readonly loopStart: number;
}

type Chord = 'Dm' | 'Bb' | 'C' | 'A' | 'Gm' | 'F';
type BassStyle = 'half' | 'march' | 'drive';
type ArpStyle = 'off' | 'fast' | 'broken';
type DrumStyle = 'none' | 'light' | 'full';

interface Phrase {
  readonly chords: readonly [Chord, Chord, Chord, Chord];
  /** Melody per bar in eighth notes, e.g. "D5:3 A4:1 D5:2 E5:2"; "r" rests. */
  readonly lead?: readonly [string, string, string, string];
  /** Rounder, quieter lead (50 % pulse) for the bridge. */
  readonly softLead?: true;
  readonly bass: BassStyle;
  readonly arp: ArpStyle;
  readonly drums: DrumStyle;
}

/** Chord tones as pitch classes (C = 0), root first. */
const CHORDS: Record<Chord, readonly [number, number, number]> = {
  Dm: [2, 5, 9],
  Bb: [10, 2, 5],
  C: [0, 4, 7],
  A: [9, 1, 4],
  Gm: [7, 10, 2],
  F: [5, 9, 0],
};

const THEME_1 = ['D5:3 A4:1 D5:2 E5:2', 'F5:3 E5:1 D5:2 Bb4:2', 'C5:3 D5:1 E5:2 G5:2', 'E5:4 C#5:2 A4:2'] as const;
const THEME_2 = ['D5:3 A4:1 D5:2 E5:2', 'F5:3 G5:1 A5:2 Bb5:2', 'A5:2 G5:2 F5:2 D5:2', 'E5:4 C#5:2 E5:2'] as const;

const INTRO: readonly Phrase[] = [{ chords: ['Dm', 'Dm', 'Bb', 'A'], bass: 'half', arp: 'broken', drums: 'none' }];

const LOOP: readonly Phrase[] = [
  // A: the theme; the arpeggio joins in its second half.
  { chords: ['Dm', 'Bb', 'C', 'A'], lead: THEME_1, bass: 'march', arp: 'off', drums: 'light' },
  { chords: ['Dm', 'Bb', 'Gm', 'A'], lead: THEME_2, bass: 'march', arp: 'fast', drums: 'light' },
  // B: brighter in F major, driving bass, full drums.
  {
    chords: ['F', 'C', 'Dm', 'Bb'],
    lead: ['A5:4 G5:2 F5:2', 'G5:4 E5:2 C5:2', 'F5:3 E5:1 D5:2 F5:2', 'D5:4 C5:2 Bb4:2'],
    bass: 'drive',
    arp: 'fast',
    drums: 'full',
  },
  {
    chords: ['F', 'C', 'Bb', 'A'],
    lead: ['A5:4 Bb5:2 C6:2', 'G5:4 E5:2 G5:2', 'F5:2 D5:2 Bb4:2 D5:2', 'C#5:4 E5:4'],
    bass: 'drive',
    arp: 'fast',
    drums: 'full',
  },
  // A again, without the arpeggio.
  { chords: ['Dm', 'Bb', 'C', 'A'], lead: THEME_1, bass: 'march', arp: 'off', drums: 'light' },
  { chords: ['Dm', 'Bb', 'Gm', 'A'], lead: THEME_2, bass: 'march', arp: 'off', drums: 'light' },
  // C: the bridge – soft lead, broken chords, no drums.
  {
    chords: ['Dm', 'Dm', 'Bb', 'A'],
    lead: ['A4:6 r:2', 'F4:2 G4:2 A4:2 C5:2', 'Bb4:4 D5:2 F5:2', 'E5:6 r:2'],
    softLead: true,
    bass: 'half',
    arp: 'broken',
    drums: 'none',
  },
  {
    chords: ['Gm', 'Gm', 'Bb', 'A'],
    lead: ['D5:4 Bb4:2 G4:2', 'A4:2 Bb4:2 C5:2 D5:2', 'F5:4 D5:2 Bb4:2', 'C#5:4 E5:4'],
    softLead: true,
    bass: 'half',
    arp: 'broken',
    drums: 'none',
  },
];

/** Bass figures per bar: [interval (0 root, 7 fifth, 12 octave), length in steps]. */
const BASS: Record<BassStyle, readonly (readonly [number, number])[]> = {
  half: [
    [0, 8],
    [7, 8],
  ],
  march: [
    [0, 4],
    [0, 2],
    [7, 2],
    [12, 4],
    [7, 4],
  ],
  drive: [
    [0, 2],
    [0, 2],
    [12, 2],
    [0, 2],
    [7, 2],
    [0, 2],
    [12, 2],
    [7, 2],
  ],
};

/** Drum lanes per bar (16 steps). The last bar of a full phrase gets a fill. */
const DRUMS: Record<Exclude<DrumStyle, 'none'>, Record<Drum, string>> = {
  light: { kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.' },
  full: { kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
};
const FILL = '....x.......x.xx';

/** Syncopated chord stabs (3-3-2 feel) for the fast arpeggio: [start step, length]. */
const ARP_HITS: readonly (readonly [number, number])[] = [
  [0, 2],
  [3, 2],
  [6, 2],
  [8, 2],
  [11, 2],
  [14, 2],
];
/** Broken chord in eighths: indices into [root, third, fifth, octave]. */
const BROKEN = [0, 1, 2, 3, 2, 1, 2, 1] as const;

const NOTE_NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#5" → 73, "Bb4" → 70. */
export function midi(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note: ${name}`);
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_NAMES[m[1]!]! + accidental;
}

/** Lowest MIDI pitch >= `floor` with the given pitch class. */
function above(pitchClass: number, floor: number): number {
  return floor + ((pitchClass - floor) % 12 + 12) % 12;
}

function compilePhrase(phrase: Phrase, steps: { notes: Note[]; drums: Drum[] }[], start: number): void {
  const at = (i: number) => steps[start + i]!;
  phrase.chords.forEach((chord, bar) => {
    const base = bar * STEPS_PER_BAR;
    const [root, third, fifth] = CHORDS[chord];

    if (phrase.lead) {
      let pos = 0;
      for (const token of phrase.lead[bar]!.split(' ')) {
        const [name, eighths] = token.split(':');
        const length = Number(eighths) * 2;
        if (name !== 'r') {
          const [tone, gain] = phrase.softLead ? (['pulse50', 0.11] as const) : (['pulse25', 0.2] as const);
          at(base + pos).notes.push({ voice: 'lead', tone, pitches: [midi(name!)], steps: length, gain });
        }
        pos += length;
      }
      if (pos !== STEPS_PER_BAR) throw new Error(`Melody bar has ${pos} steps: ${phrase.lead[bar]}`);
    }

    const bassRoot = above(root, 38); // D2 … C#3
    let pos = 0;
    for (const [interval, length] of BASS[phrase.bass]) {
      at(base + pos).notes.push({ voice: 'bass', tone: 'triangle', pitches: [bassRoot + interval], steps: length, gain: 0.34 });
      pos += length;
    }

    // Chord tones voiced from A3 upwards, below the melody.
    const voicing = [root, third, fifth].map((pc) => above(pc, 57)).sort((a, b) => a - b);
    if (phrase.arp === 'fast') {
      for (const [step, length] of ARP_HITS) {
        at(base + step).notes.push({ voice: 'arp', tone: 'pulse12', pitches: voicing, steps: length, gain: 0.07 });
      }
    } else if (phrase.arp === 'broken') {
      const tones = [...voicing, voicing[0]! + 12];
      BROKEN.forEach((index, i) => {
        at(base + i * 2).notes.push({ voice: 'arp', tone: 'pulse50', pitches: [tones[index]!], steps: 2, gain: 0.07 });
      });
    }

    if (phrase.drums !== 'none') {
      const lanes = { ...DRUMS[phrase.drums] };
      if (phrase.drums === 'full' && bar === 3) lanes.snare = FILL;
      for (const [drum, lane] of Object.entries(lanes) as [Drum, string][]) {
        for (let i = 0; i < STEPS_PER_BAR; i++) if (lane[i] === 'x') at(base + i).drums.push(drum);
      }
    }
  });
}

function compile(phrases: readonly Phrase[]): Step[] {
  const steps = Array.from({ length: phrases.length * 4 * STEPS_PER_BAR }, () => ({ notes: [] as Note[], drums: [] as Drum[] }));
  phrases.forEach((phrase, i) => compilePhrase(phrase, steps, i * 4 * STEPS_PER_BAR));
  return steps;
}

export function compileSong(): Song {
  const intro = compile(INTRO);
  return { steps: [...intro, ...compile(LOOP)], loopStart: intro.length };
}
