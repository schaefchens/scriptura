# Scriptura

A scripture reader for React Native and the web. Books of any scripture – a book of the Bible in one edition, a surah – in any script and direction, as running text or a verse per line, in pages with columns or one endless scroll; other editions read along verse by verse, inline or side by side. A word can be tapped, reached word by word or jumped to by its place; screen readers read each verse in its language. Passages are read aloud by the device's voices, or from recordings of their chapters – a recitation, a narrator – marking each word as it is said.

Status: built October 2026 from the reader spikes of the Hosana app, its first user; Scriptura depends on nothing from it. It holds no texts: an app adds books as JSON, which the import tool makes from open sources.

| Path | Contents |
| --- | --- |
| [src](src) | The core in Rust: books, passages as paragraphs, reading along, what is read aloud and from which recordings – its API documented in the code: `cargo doc --open`. Tests: `cargo test` |
| [bindings/ffi](bindings/ffi) | The core for Swift and Kotlin, through UniFFI; only native code binds it |
| [bindings/wasm](bindings/wasm) | The core for the web, through wasm-bindgen |
| [bindings/js](bindings/js) | `@schaefchens/scriptura`: the shared TypeScript – types, the palette, fonts per script – and `scriptura-import` |
| [bindings/react-native](bindings/react-native) | `@schaefchens/scriptura-react-native`: the reader for iOS and Android, an Expo module: `npm run build:native` |
| [bindings/web](bindings/web) | `@schaefchens/scriptura-web`: the reader in the page, for any framework or none: `npm run build` |
| [bindings/react](bindings/react) | `@schaefchens/scriptura-react`: the web reader as a React component |
| [examples/react-native](examples/react-native) | An Expo app reading the examples' editions on iOS and Android |
| [examples/web](examples/web) | The same in a Vite page |

## How it works

- **The core** makes passages into paragraphs: a chapter's heading, its running text or a verse per line, each in its book's language, direction and script, with every verse and word where it stands. A font's size comes from a typical letter of its script, measured in the font in use, so every script looks as large.
- **Reading along:** editions of a book share its USFM code, and every verse carries its number in the KJV, the key they share: the Hebrew Jonah 2:1 stands beside the English 1:17, a psalm's title gets a row of its own. In a reading list side by side, a passage nothing is read along with flows as it would alone.
- **Text and JavaScript:** on iOS and Android the readers take a passage's text from the core themselves. JS adds books by file, by one the app bundles or as JSON, and learns only what they are and where a word stands – so an app can keep the text out of JS entirely. On the web the text is the page's anyway.
- **Layout:** iOS lays the text out with TextKit 2 off the main thread, in chunks of paragraphs – those up to the reader's place first, then the rest across the cores – and shows parts of it in text views of their own; Android lays out its first pages with StaticLayout at once and the rest on a thread, drawn clipped to each column or cell; the web uses the DOM, CSS columns for pages and a grid per row for books side by side, and in a scroll the browser lays out only what comes into sight.
- **Pages side by side:** a page holds the rows that fit, and headings only with the row after them; a row taller than a page, or than what its headings leave, is cut between lines and goes on in its columns over the pages after.
- **Reading aloud:**
  - The core makes the spoken text from its words: each heading on its own, the verses without their numbers, a mushaf's verses ending at a stop, Hebrew without its cantillation.
  - It cuts the text only at sentence ends. The first utterance is short, so the voice starts at once; each after it is twice as long, up to what the engine takes – or what the voice starts at once: some prepare all of an utterance before they speak it. Each is given to the voice as the one before sounds.
  - The readers speak with the platform's voices – AVSpeechSynthesizer, Android's TextToSpeech, the browser's speechSynthesis – a voice for each passage's language, and mark the words as the voice reports them.
  - On iOS and Android the text goes from the core to the voice without passing through JS. Only voices on the device speak.
  - A tap, a move or a jump while it speaks goes on from that word. Of books read along, only the passage's own is read, unless `speakAlong`.
  - `speechRate` is a multiple of the voice's own rate, from 0.5 to 2. Where an engine's scale is no multiple – Apple's, and Google's below 1 – the reader maps it as measured; browsers get it as it is.
  - The reader keeps the word the voice is at in sight. Scrolled or turned away by hand, it stays where the hand put it while the voice reads on, until the word is in sight again or `follow()` brings it back; `onSpeechChange` says which (`following`).
- **Recordings:**
  - A recording is a chapter's audio, in one file, and where each verse and each word starts in it, in milliseconds; a word ends where the next starts. It names the version of the core's word definition its timings count by: the core refuses another, and plays a recording only for a chapter whose verses and words it matches, so the marked word can't slip. `recordings()` says why one doesn't fit, if it doesn't.
  - Reading aloud plays each chapter that has a recording from it – of the voices `recordedVoices` names by their ids, the first that has one, or with none named, any – and the device's voices read the rest. No heading is spoken before recorded verses.
  - As with voices, a tap, a move or a jump goes on from that word: the audio seeks there. A verse range plays from its first verse's start to where the next verse starts. A pause pauses in place, and a new rate applies at once, the voice's pitch kept.
  - The readers play with AVPlayer, Media3's ExoPlayer and an audio element, and mark the word the player's clock is at, every frame. Between the Android player's reports – the emulator's come every quarter second – the clock moves on at the rate.
  - A recording that follows a device's voice is loaded and sought while the voice still speaks.
  - An app adds recordings as it adds books: from a file, one it bundles or JSON. Their audio, named relative to them, never passes through JS. On iOS they play in the app's audio session, as spoken audio, so the silent switch doesn't mute them; on Android they take the audio focus, and pause when another app takes it or the headphones come off.
  - **Audio from a source:** audio an app keeps where no file is – in encrypted storage, say – it gives the players through an `AudioSource` of its own, registered natively for a URI scheme (`AudioSources.register`), which they read piece by piece as they play: through AVPlayer's resource loader on iOS, a Media3 data source on Android. So the audio is never written out whole.
- **In the background:** with `nowPlaying` – a title and a subtitle the app chooses – the system's media controls show the reader while it reads aloud, play and pause it and move it by a verse, and it reads on with the screen off or in another app: on Android in a media service in the foreground. Without it, they show nothing of it, and reading aloud pauses as the app goes to the background. The reading stays with the reader: it stops as the reader goes away. Takes end where they end without frames to watch, too.
- **Changes:** on every platform, readers follow their library's changes: new books lay them out anew, and what they had still to read goes with the books or recordings that change.

## Use

```tsx
// React Native, with ["@schaefchens/scriptura-react-native", { "books": ["./texts/books.json"], "recordings": ["./recordings"], "backgroundAudio": true }] in app.json's plugins
import { addBooks, addRecordings, Reader, SCRIPT_FONTS } from '@schaefchens/scriptura-react-native';

await addBooks({ asset: 'books.json' });
await addRecordings({ asset: 'recordings.json' });
<Reader ref={reader} passages={[{ book: 'jonah' }]} fonts={SCRIPT_FONTS} recordedVoices={['alafasy']} nowPlaying={{ title: 'Jonah' }} onWordChange={(position) => …} onSpeechChange={(speech) => …} />;
await reader.current.jump({ passage: 0, book: 'jonah', chapter: 2, verse: 1, word: 0 });
await reader.current.play(); // pause(), stop(), follow() after a scroll away

// The web
import { addScriptFonts, createReader, Library, loadScriptura, SCRIPT_FONTS } from '@schaefchens/scriptura-web';

await loadScriptura();
const library = new Library();
await library.fetch('/texts/books.json');
await library.fetchRecordings('/recordings/recordings.json');
addScriptFonts('/fonts/');
const reader = createReader(element, { library, passages: [{ book: 'jonah' }], fonts: SCRIPT_FONTS });
reader.play();
```

Audio from a source, in the app's native code – Swift here, Kotlin alike – for recordings whose audio is `vault:///17.m4a`, say:

```swift
final class VaultAudio: AudioSource {
  func length(of uri: URL) -> Int64? { … }                       // the audio's length in bytes
  func read(_ uri: URL, range: Range<Int64>) -> Data? { … }     // a piece of it, decrypted
}
AudioSources.register(VaultAudio(), scheme: "vault")
```

## Texts, recordings and fonts

`scriptura-import <config.json>` takes Bibles as USFM, as eBible.org has them, or as OSIS, as the Open Scriptures Hebrew Bible has them, and surahs from Tanzil's text with quran-tajweed's rules; and it fetches the reader's fonts per script, all under the SIL Open Font License. Each text has a license of its own: check it before passing it on, with the notice it asks for. The examples take public-domain and openly licensed editions; [tests/fixtures](tests/fixtures) holds 46 verses and their sources.

It also makes recordings of surahs: EveryAyah's recitations, a file per verse, joined into one file per surah and encoded once with ffmpeg – AAC in M4A, or Opus or MP3 – and timed by [quran-align](https://github.com/cpfair/quran-align)'s word timings (© 2016 Collin Fair, CC BY 4.0) for 12 recitations, or [QuranLab](https://huggingface.co/datasets/quranlab/quran-audio)'s (CC BY 4.0) for 33 more, read from its rows a hundred at a time. Both count words as the core does. Some of EveryAyah's files changed since they were timed: where a verse's timings outlast its audio, as in Alafasy's 37:152, its words are spread over it by their letters. No recitation is known to be under an open license, so the examples fetch them for trying out only, and keep them out of git.

## Building

- **Core:** `cargo test`, `cargo clippy --workspace --all-targets`.
- **React Native:** `npm run build:native -w bindings/react-native` builds the core for iOS and Android; it needs rustup's iOS and Android targets, cargo-ndk, Xcode and ANDROID_HOME. Then, in examples/react-native, `npm run texts` and `npx expo run:ios` or `run:android`.
- **Web:** `npm run build -w bindings/web` needs the wasm32 target and wasm-bindgen-cli 0.2.129. Then, in examples/web, `npm run texts` and `npm run dev`.
- **TypeScript:** `npm run build` builds the web packages and the shared one into their dist folders, which apps from npm get; React Native, and the examples here, take the sources.
- package-lock.json holds Expo's packages as published by 2026-10-27 (`npm install --before`): those released the day after asked for an expo-constants not yet published, and ExpoModulesJSI didn't compile.

## What the tests show

2026-10-28, on the iPhone 17 simulator, an Android 16 emulator with Google's speech engine and Brave (Chromium 155) on a Mac:

- **Every script renders,** in the reader's own fonts: Hebrew with points and cantillation, polytonic Greek, vocalized Arabic, Persian (on iOS and Android; the web example has none) and the Quran with its tajweed colors.
- **Reading along** matches verses across numbering schemes, inline and side by side, in reading lists too; right-to-left books run their columns and pages from the right.
- **Speed:** the Psalms in Hebrew, English and German, a verse per line (7,449 verses), side by side, show their first pages after 0.6 s on iOS and 0.5 s on Android, and are laid out in full after 1.0 s and 1.7 s; the English Psalms alone, a verse per line, take 0.17 s in the browser.
- **Reading aloud**, also on an Android emulator with Google's speech engine:
  - English, German, Hebrew, Greek and Arabic have voices on all three platforms; Persian has none on any.
  - The highlight follows every word on iOS and Android – on Android within 20 ms of where it sounds – and most in Brave, which joins some short words with the next.
  - Psalm 119, within the whole Psalms, sounds after 0.8–0.9 s on iOS, 0.6 s on Android and 0.4 s in Brave. After a tap or a jump while speaking, the voice goes on after 0.07–0.4 s.
  - Without its cantillation, Google's Hebrew voice reads twice as fast; Apple's reads Hebrew alike either way.
  - Switching voices – books read along verse by verse, reading lists that change language – costs 0.1–0.7 s on Android and a Mac, 3–19 s on the iOS simulator.
  - The rate (2026-10-29): 0.5 reads at 0.50 times the voice's speed on iOS and Android, 0.77 in Brave; 2 at 2.08, 1.97 and 1.96 times.
  - Google's Hebrew voice starts utterances of up to 800 characters within 0.03 s, but waited 0.4 s before one of 1,600 and 2.7 s before one of 3,200; the reader then gives it about 1,100, which it starts within 0.03 s. Apple's voices on a Mac and Brave's start each within 0.1 s, up to 2,000 characters.
  - Scrolled away – by finger on Android, by the wheel in Brave, by `turn()` on iOS – the reader stays while the voice reads on, and follows it again once its word is in sight or after `follow()`.
- **Recordings** (2026-10-29), Mishary Rashid Alafasy's recitation, also of Al-Baqarah, two hours in 60 MB:
  - Each word is marked within 15 ms of its timing on iOS and in Brave, at 0.5×, 1× and 2×, and on Android at 1×; there within 25 ms at the other rates.
  - The first sound, from the start of a surah: 0.2–0.5 s on iOS, 0.2–0.7 s on Android, 20–40 ms in Brave. From Al-Baqarah 2:255, an hour in: 0.54 s on iOS, 0.3 s on Android. After a jump while it plays: 0.07–0.17 s, and about 0.1 s in Brave, whose clock creeps that long after a seek. A seek lands on the very start of the verse.
  - A reading list that mixes the device's voice and recordings goes from one to the other: the recitation's first word comes 0.7 s after the voice's last on iOS, 1.4 s on Android, where Google's engine reports an utterance done 1.2 s after its last word began.
  - Without a speech engine, as on Android's default emulator image, recordings still play.
  - AAC, MP3 and Opus, in Ogg or MP4, play on all three; Opus in WebM not on iOS, in CAF only there.
  - From a source – an encrypted vault ([Temple](https://github.com/schaefchens/temple-vault)), read a piece at a time – they play as from a file: the first sound after 0.26–0.34 s on iOS and Android, 0.07–0.2 s after a jump, each word within 13 ms.
  - In the background, on Android: the media service runs in the foreground, its notification shows the title, and media keys pause, play and move it by a verse. On iOS the system takes the app as the one playing and it plays on with the screen locked; the simulator draws no media controls to look at.

## Open

- Reading aloud: the voices by ear on phones and their better versions; switching voices on an iPhone; reading on with the screen off; the rate in other engines and browsers; a finger's scroll on iOS, so far tried by `turn()` only.
- Recordings: the media controls on an iPhone's lock screen, and in a browser; calls and other apps interrupting on a phone. Audio sources on the web: there, an app can hand the reader a blob's URL.
- Android lays out all after its first pages on one thread; iOS shares that out among the cores.
- In pages, the web reader lays out the whole text at once, to count them; in a scroll it holds the whole text, but lays out only what is in sight.
- Side by side in pages, the row after one cut over pages starts on a page of its own.
- Not on npm yet: `npm run build` and `build:native` make what the packages would publish.
