import type { Passage, SpeechChange, Voice, WordPosition } from '@schaefchens/scriptura';

import type { Library, Speech, Take, Utterance } from './library';
import { PlayRecording } from './playRecording';

/** The first utterance's length, and the longest, in UTF-16 code units: Chromium takes up to 32,767. */
const FIRST_LENGTH = 200;
const LENGTH = 32000;
/**
 * An utterance that sounds this late after the one before, in milliseconds, started late – a voice that prepares as it speaks takes
 * 100 – and the voice's next take as long as it starts in that.
 */
const LATE = 300;

/**
 * The longest utterance each voice starts at once, by its URI, where that is shorter: a voice that prepares all of an utterance
 * before it speaks takes the longer to start, the longer it is.
 */
const promptLengths = new Map<string, number>();

/** An utterance given to the browser, the core's of it, and whether it sounded yet. */
type Queued = { spoken: SpeechSynthesisUtterance; utterance: Utterance; sounded: boolean };

/**
 * Reads passages aloud: chapters with recordings from them, the rest with the browser's voices, a voice for each language. It takes
 * the parts from the core one after the other: a take of a recording plays once the voice has said what it was given. The voice's
 * utterances: the first is short, so the voice starts at once; each after it twice as long as the one before, so few sentences are
 * cut apart – as long as the voice starts them at once. Each is given as the one before it sounds, so the voice can prepare it. It
 * tells the reader the word the voice comes to, as the browser reports it, or a recording's timings have it. Only voices on the
 * device speak: a network voice would send the text away. Browsers don't pause voices reliably, so a pause stops them, and play goes
 * on from the word the reader is at; a recording pauses in place.
 */
export class ReadAloud {
  state: SpeechChange['state'] = 'stopped';
  /** A voice per language, by id; otherwise the browser's for it. */
  voices: Record<string, string> = {};
  /** How fast the voices read, as a multiple of their own rate: from 0.5 to 2. */
  rate = 1;
  private speech: Speech | undefined;
  private recording: PlayRecording;
  /** The take of a recording that plays, or that waits for the voice to say what it was given. */
  private take: Take | undefined;
  private takeWaits = false;
  /** Where it paused in a take: play goes on there, from that word. */
  private pausedAt: WordPosition | undefined;
  /** The utterances given to the browser and not yet done, as the core made them. */
  private queued: Queued[] = [];
  private started: number | undefined;
  private unvoiced = new Set<string>();
  /** How long the next utterance may be. */
  private nextLength = FIRST_LENGTH;
  /** When the last utterance ended, and in which voice: the next one in it sounds at once. */
  private ended: { time: number; voice: string } | undefined;
  /** Counts the starts, so a start that waited for the voices and was replaced meanwhile is dropped. */
  private starts = 0;

  constructor(
    private onWord: (part: { passage: number; book: string }, word: Utterance['words'][number] | Take['words'][number]) => void,
    private onChange: (change: SpeechChange) => void,
  ) {
    this.recording = new PlayRecording(
      (take, word) => this.onWord(take, word),
      (time) => this.sounded(time),
      () => this.takeEnded(),
      () => this.stop(),
    );
  }

  /**
   * Reads the passages from the word at `from`, or from their start, playing chapters from recordings of the `recorded` voices –
   * with none named, of any. A recording paused at that word goes on.
   */
  play(library: Library, passages: Passage[], companions: string[], along: boolean, from?: WordPosition, recorded?: string[]) {
    if (this.state === 'paused' && this.take && samePlace(from, this.pausedAt)) {
      this.started = performance.now();
      this.recording.rate = this.rate;
      this.recording.resume();
      return this.change('speaking');
    }
    this.silence();
    const start = ++this.starts;
    this.speech = library.speech(passages, { companions, along, recorded }, from);
    this.started = performance.now();
    this.change('speaking');
    loadVoices().then(() => {
      if (start !== this.starts) return;
      this.enqueue();
      this.enqueue();
      if (this.queued.length === 0 && !this.take) this.stop();
    });
  }

  /** Pauses a recording at the word `at` which the reader is; stops a voice, to go on from there. */
  pause(at?: WordPosition) {
    if (this.state !== 'speaking') return;
    if (this.take && !this.takeWaits) {
      this.recording.pause();
      this.pausedAt = at;
      return this.change('paused');
    }
    this.silence();
    this.change('paused');
  }

  /** A new rate: a recording takes it at once; a voice only with what it is given next, so it is false for one. */
  setRate(rate: number) {
    this.rate = rate;
    if (!this.take || this.takeWaits) return false;
    this.recording.setRate(rate);
    return true;
  }

  /** Stops; the languages skipped for want of a voice go with the news. */
  stop() {
    const wasStopped = this.state === 'stopped';
    const unvoiced = [...this.unvoiced].sort();
    this.silence();
    if (!wasStopped) this.change('stopped', unvoiced.length > 0 ? { unvoiced } : {});
  }

  /** Drops what was to be said, without a word to the page. */
  private silence() {
    this.starts++;
    this.speech?.free();
    this.speech = undefined;
    this.recording.stop();
    this.take = undefined;
    this.takeWaits = false;
    this.pausedAt = undefined;
    this.queued = [];
    this.started = undefined;
    this.unvoiced.clear();
    this.nextLength = FIRST_LENGTH;
    this.ended = undefined;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.state = 'stopped';
  }

  /** Tells what changed; while it reads, with whose recording plays. */
  private change(state: SpeechChange['state'], details: Omit<SpeechChange, 'state'> = {}) {
    this.state = state;
    const recording = this.take && !this.takeWaits ? this.take.voice : '';
    this.onChange(state === 'speaking' ? { recording, ...details, state } : { ...details, state });
  }

  /** Gives the browser the next utterance with a voice – or the next take to play, once the voice has said what it was given. */
  private enqueue() {
    if (this.take) return;
    for (let part = this.speech?.next(this.nextLength); part; part = this.speech?.next(this.nextLength)) {
      if ('play' in part) {
        this.take = part.play;
        this.takeWaits = this.queued.length > 0;
        if (this.takeWaits) this.recording.prepare(part.play);
        else this.playTake();
        return;
      }
      const utterance = part.speak;
      const voice = voiceFor(utterance.language, this.voices);
      if (!voice) {
        if (!this.unvoiced.has(utterance.language)) {
          this.unvoiced.add(utterance.language);
          this.change(this.state, { unvoiced: [...this.unvoiced].sort() });
        }
        continue;
      }
      const spoken = new SpeechSynthesisUtterance(utterance.text);
      spoken.voice = voice;
      spoken.lang = voice.lang;
      spoken.rate = Math.min(Math.max(this.rate, 0.5), 2);
      const entry: Queued = { spoken, utterance, sounded: false };
      // The first sound comes with the first word: "start" comes before it, as the voice prepares.
      // A voice that reports no words sounds from its start.
      let startedAt: number | undefined;
      spoken.onstart = () => (startedAt = performance.now());
      spoken.onboundary = (event) => {
        if (event.name !== 'word' || !this.queued.includes(entry)) return;
        this.sounded(performance.now());
        if (!entry.sounded) {
          this.soundedFirst(entry, performance.now());
          if (this.queued.length < 2) this.enqueue();
        }
        // The word the boundary is in, or the first, if it comes before any.
        const word = utterance.words.findLast((candidate) => candidate.start <= event.charIndex) ?? utterance.words[0];
        if (word) this.onWord(utterance, word);
      };
      const done = (event: SpeechSynthesisEvent) => {
        if (!this.queued.includes(entry)) return;
        // A voice that ends an utterance it never started can't speak: rather than run through the
        // rest, as Brave once did with every utterance, reading stops.
        if (startedAt === undefined) return this.stop();
        this.sounded(startedAt);
        this.finished(entry);
        if (event.type === 'end') this.ended = { time: performance.now(), voice: voice.voiceURI };
      };
      spoken.onend = done;
      spoken.onerror = done;
      this.queued.push(entry);
      speechSynthesis.speak(spoken);
      this.nextLength = Math.min(this.nextLength * 2, promptLengths.get(voice.voiceURI) ?? LENGTH);
      return;
    }
  }

  /** An utterance's first word sounded, at `time`: if it was late after the one before in its voice, the voice prepares an utterance before it speaks, and the next are shorter. */
  private soundedFirst(entry: Queued, time: number) {
    entry.sounded = true;
    const ended = this.ended;
    this.ended = undefined;
    const voice = entry.spoken.voice?.voiceURI;
    if (!ended || !voice || ended.voice !== voice || time - ended.time <= LATE) return;
    const length = Math.max(Math.floor((entry.utterance.text.length * LATE) / (time - ended.time)), FIRST_LENGTH);
    promptLengths.set(voice, Math.min(promptLengths.get(voice) ?? LENGTH, length));
    this.nextLength = Math.min(this.nextLength, length);
  }

  /** The voice sounded at `time`: reported once after a start. */
  private sounded(time: number) {
    if (this.started === undefined) return;
    this.change('speaking', { firstSound: Math.max(time - this.started, 0) });
    this.started = undefined;
  }

  private finished(entry: Queued) {
    if (!this.queued.includes(entry)) return;
    this.queued = this.queued.filter((other) => other !== entry);
    this.ended = undefined;
    if (this.queued.length > 0) return;
    if (this.take) return this.playTake();
    // For a voice that reports no words, the next is given now.
    this.enqueue();
    this.enqueue();
    if (this.queued.length === 0 && !this.take) this.stop();
  }

  private playTake() {
    this.takeWaits = false;
    this.recording.rate = this.rate;
    this.recording.play(this.take!);
    this.change('speaking');
  }

  /** A take played to its end: what follows it is read. */
  private takeEnded() {
    this.take = undefined;
    this.enqueue();
    this.enqueue();
    if (this.queued.length === 0 && !this.take) this.stop();
  }
}

const samePlace = (a?: WordPosition, b?: WordPosition) =>
  a !== undefined && b !== undefined && a.passage === b.passage && a.book === b.book && a.chapter === b.chapter && a.verse === b.verse && a.word === b.word;

/** The browser's voices, once it has them: some browsers load them only when first asked. */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([]);
  const voices = speechSynthesis.getVoices();
  if (voices.length > 0) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener('voiceschanged', done);
    setTimeout(done, 1000);
  });
}

/** The voices on the device that can read aloud. */
export async function speechVoices(): Promise<Voice[]> {
  return (await loadVoices()).filter((voice) => voice.localService).map((voice) => ({ id: voice.voiceURI, name: voice.name, language: voice.lang }));
}

/** The voice chosen for a language, or the browser's default if it speaks it, or one of the page's region, or the first. */
function voiceFor(language: string, chosen: Record<string, string>) {
  const voices = speechSynthesis.getVoices().filter((voice) => voice.localService);
  const primary = (tag: string) => tag.toLowerCase().split(/[-_]/)[0];
  const candidates = voices.filter((voice) => primary(voice.lang) === primary(language));
  const region = (tag: string) => tag.toLowerCase().split(/[-_]/)[1];
  return (
    candidates.find((voice) => voice.voiceURI === chosen[language]) ??
    candidates.find((voice) => voice.default) ??
    candidates.find((voice) => region(voice.lang) === region(navigator.language)) ??
    candidates[0]
  );
}
