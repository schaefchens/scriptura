import type { Take } from './library';

/**
 * Plays takes of recordings in an audio element of its own: from a take's start to its end, telling the word the audio comes to, as
 * the take's timings have it, frame by frame. A take of the audio already loaded seeks in it. The browser keeps the voice's pitch at
 * every rate.
 */
export class PlayRecording {
  /** How fast it plays: from 0.5 to 2. */
  rate = 1;
  private audio: HTMLAudioElement | undefined;
  private take: Take | undefined;
  /** The word the audio came to last, as its index in the take. */
  private word = -1;
  private frame = 0;
  /** Where the audio was as it was started, until it moves on from there: then it sounds. */
  private startedAt: number | undefined;

  constructor(
    private onWord: (take: Take, word: Take['words'][number]) => void,
    /**
     * The audio sounds, after a start or a seek, at `time`, as performance.now() counts it. Its time creeps after a seek, in Brave for a
     * tenth of a second: it counts as sounding once it ran on 50 ms, from 50 ms before.
     */
    private onSound: (time: number) => void,
    private onEnd: () => void,
    private onError: () => void,
  ) {}

  play(take: Take) {
    this.prepare(take);
    this.take = take;
    this.word = -1;
    this.resume();
  }

  /** Loads a take's audio and goes to its start, to play it at once as its turn comes. */
  prepare(take: Take) {
    const audio = (this.audio ??= this.element());
    const url = new URL(take.audio, location.href).href;
    // Audio that failed to load is loaded anew.
    if (audio.src !== url || audio.error) audio.src = url;
    audio.currentTime = take.start / 1000;
  }

  /** Goes on where it paused. */
  resume() {
    if (!this.audio || !this.take) return;
    this.audio.playbackRate = Math.min(Math.max(this.rate, 0.5), 2);
    this.startedAt = this.audio.currentTime;
    this.audio.play().catch((error: DOMException) => {
      // A pause or a new take before it started.
      if (error.name !== 'AbortError') this.onError();
    });
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.follow);
  }

  pause() {
    cancelAnimationFrame(this.frame);
    this.audio?.pause();
  }

  stop() {
    this.pause();
    this.take = undefined;
  }

  /** A new rate, at once. */
  setRate(rate: number) {
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = Math.min(Math.max(rate, 0.5), 2);
  }

  private element() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('ended', () => this.take && this.end());
    // A hidden page gets no frames: its take still ends where it ends, a quarter second later at most.
    audio.addEventListener('timeupdate', () => {
      if (this.take?.end != null && audio.currentTime * 1000 >= this.take.end) this.end();
    });
    audio.addEventListener('error', () => this.take && this.onError());
    return audio;
  }

  /** Tells the word the audio is at, while it plays, and ends the take where it ends. */
  private follow = () => {
    const { audio, take } = this;
    if (!audio || !take) return;
    const time = audio.currentTime * 1000;
    if (this.startedAt !== undefined && !audio.seeking && audio.currentTime >= this.startedAt + 0.05) {
      this.startedAt = undefined;
      this.onSound(performance.now() - 50 / audio.playbackRate);
    }
    if (take.end !== null && time >= take.end) return this.end();
    const word = take.words.findLastIndex((candidate) => candidate.start <= time);
    if (word >= 0 && word !== this.word) {
      this.word = word;
      this.onWord(take, take.words[word]);
    }
    this.frame = requestAnimationFrame(this.follow);
  };

  private end() {
    if (!this.take) return;
    this.stop();
    this.onEnd();
  }
}
