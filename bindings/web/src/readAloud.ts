import type { Passage, SpeechChange, Voice, WordPosition } from '@schaefchens/scriptura';

import type { Library, Speech, Utterance } from './library';

/** The first utterance's length, and the others', in UTF-16 code units: Chromium takes up to 32,767. */
const FIRST_LENGTH = 200;
const LENGTH = 32000;

/** An utterance given to the browser, and the core's of it. */
type Queued = { spoken: SpeechSynthesisUtterance; utterance: Utterance };

/**
 * Reads passages aloud with the browser's voices, a voice for each language: utterances from the
 * core, one after the other. The first is short, so the voice starts at once; the rest are long, so
 * few sentences are cut apart. It tells the reader the word the voice comes to, as the browser
 * reports it. Only voices on the device speak: a network voice would send the text away. Browsers
 * don't pause reliably, so a pause stops, and play goes on from the word the reader is at.
 */
export class ReadAloud {
  state: SpeechChange['state'] = 'stopped';
  /** A voice per language, by id; otherwise the browser's for it. */
  voices: Record<string, string> = {};
  private speech: Speech | undefined;
  /** The utterances given to the browser and not yet done, as the core made them. */
  private queued: Queued[] = [];
  private started: number | undefined;
  private unvoiced = new Set<string>();
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
      this.enqueue(FIRST_LENGTH);
      this.enqueue(LENGTH);
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
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.state = 'stopped';
  }

  private change(state: SpeechChange['state'], details: Omit<SpeechChange, 'state'> = {}) {
    this.state = state;
    this.onChange({ ...details, state });
  }

  /** Gives the browser the next utterance with a voice, at most `length` long. */
  private enqueue(length: number) {
    for (let utterance = this.speech?.next(length); utterance; utterance = this.speech?.next(length)) {
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
      const entry: Queued = { spoken, utterance };
      // The first sound comes with the first word: "start" comes before it, as the voice prepares.
      // A voice that reports no words sounds from its start.
      let startedAt: number | undefined;
      spoken.onstart = () => (startedAt = performance.now());
      spoken.onboundary = (event) => {
        if (event.name !== 'word' || !this.queued.includes(entry)) return;
        this.sounded(performance.now());
        // The word the boundary is in, or the first, if it comes before any.
        const word = utterance.words.findLast((candidate) => candidate.start <= event.charIndex) ?? utterance.words[0];
        if (word) this.onWord(utterance, word);
      };
      spoken.onend = spoken.onerror = () => {
        if (!this.queued.includes(entry)) return;
        // A voice that ends an utterance it never started can't speak: rather than run through the
        // rest, as Brave once did with every utterance, reading stops.
        if (startedAt === undefined) return this.stop();
        this.sounded(startedAt);
        this.finished(entry);
      };
      this.queued.push(entry);
      speechSynthesis.speak(spoken);
      return;
    }
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
    this.enqueue(LENGTH);
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
