import type { Passage, SpeechChange, Voice, WordPosition } from '@schaefchens/scriptura';

import type { Library, Speech, Utterance } from './library';

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
 * Reads passages aloud with the browser's voices, a voice for each language: utterances from the
 * core, one after the other. The first is short, so the voice starts at once; each after it twice as
 * long as the one before, so few sentences are cut apart – as long as the voice starts them at once.
 * Each is given as the one before it sounds, so the voice can prepare it. It tells the reader the
 * word the voice comes to, as the browser reports it. Only voices on the device speak: a network voice would send the text away. Browsers
 * don't pause reliably, so a pause stops, and play goes on from the word the reader is at.
 */
export class ReadAloud {
  state: SpeechChange['state'] = 'stopped';
  /** A voice per language, by id; otherwise the browser's for it. */
  voices: Record<string, string> = {};
  /** How fast the voices read, as a multiple of their own rate: from 0.5 to 2. */
  rate = 1;
  private speech: Speech | undefined;
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
    private onWord: (utterance: Utterance, word: Utterance['words'][number]) => void,
    private onChange: (change: SpeechChange) => void,
  ) {}

  /** Reads the passages from the word at `from`, or from their start. */
  play(library: Library, passages: Passage[], companions: string[], along: boolean, from?: WordPosition) {
    this.silence();
    const start = ++this.starts;
    this.speech = library.speech(passages, { companions, along }, from);
    this.started = performance.now();
    this.change('speaking');
    loadVoices().then(() => {
      if (start !== this.starts) return;
      this.enqueue();
      this.enqueue();
      if (this.queued.length === 0) this.stop();
    });
  }

  pause() {
    if (this.state !== 'speaking') return;
    this.silence();
    this.change('paused');
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
    this.queued = [];
    this.started = undefined;
    this.unvoiced.clear();
    this.nextLength = FIRST_LENGTH;
    this.ended = undefined;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.state = 'stopped';
  }

  private change(state: SpeechChange['state'], details: Omit<SpeechChange, 'state'> = {}) {
    this.state = state;
    this.onChange({ ...details, state });
  }

  /** Gives the browser the next utterance with a voice. */
  private enqueue() {
    for (let utterance = this.speech?.next(this.nextLength); utterance; utterance = this.speech?.next(this.nextLength)) {
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
    this.change('speaking', { firstSound: time - this.started });
    this.started = undefined;
  }

  private finished(entry: Queued) {
    if (!this.queued.includes(entry)) return;
    this.queued = this.queued.filter((other) => other !== entry);
    this.ended = undefined;
    // For a voice that reports no words, the next is given now.
    if (this.queued.length === 0) {
      this.enqueue();
      this.enqueue();
    }
    if (this.queued.length === 0) this.stop();
  }
}

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
