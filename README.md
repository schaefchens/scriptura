# Scriptura

A scripture reader for React Native and the web. Books of any scripture – a book of the Bible in one edition, a surah – in any script and direction, as running text or a verse per line, in pages with columns or one endless scroll; other editions read along verse by verse, inline or side by side. A word can be tapped or reached word by word, and screen readers read each verse in its language.

Status: built October 2026 from the reader spikes of the Hosana app, its first user; Scriptura depends on nothing from it. It holds no texts: an app adds books as JSON, which the import tool makes from open sources.

| Path | Contents |
| --- | --- |
| [src](src) | The core in Rust: books, passages as paragraphs, reading along – its API documented in the code: `cargo doc --open`. Tests: `cargo test` |
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

## Use

```tsx
// React Native, with ["@schaefchens/scriptura-react-native", { "books": ["./texts/books.json"] }] in app.json's plugins
import { addBooks, Reader, SCRIPT_FONTS } from '@schaefchens/scriptura-react-native';

await addBooks({ asset: 'books.json' });
<Reader passages={[{ book: 'jonah' }]} fonts={SCRIPT_FONTS} onWordChange={(position) => …} />;

// The web
import { addScriptFonts, createReader, Library, loadScriptura, SCRIPT_FONTS } from '@schaefchens/scriptura-web';

await loadScriptura();
const library = new Library();
await library.fetch('/texts/books.json');
addScriptFonts('/fonts/');
createReader(element, { library, passages: [{ book: 'jonah' }], fonts: SCRIPT_FONTS });
```

## Texts and fonts

`scriptura-import <config.json>` takes Bibles as USFM, as eBible.org has them, or as OSIS, as the Open Scriptures Hebrew Bible has them, and surahs from Tanzil's text with quran-tajweed's rules; and it fetches the reader's fonts per script, all under the SIL Open Font License. Each text has a license of its own: check it before passing it on, with the notice it asks for. The examples take public-domain and openly licensed editions; [tests/fixtures](tests/fixtures) holds 46 verses and their sources.

## Building

- **Core:** `cargo test`, `cargo clippy --workspace --all-targets`.
- **React Native:** `npm run build:native -w bindings/react-native` builds the core for iOS and Android; it needs rustup's iOS and Android targets, cargo-ndk, Xcode and ANDROID_HOME. Then, in examples/react-native, `npm run texts` and `npx expo run:ios` or `run:android`.
- **Web:** `npm run build -w bindings/web` needs the wasm32 target and wasm-bindgen-cli 0.2.129. Then, in examples/web, `npm run texts` and `npm run dev`.
- **TypeScript:** `npm run build` builds the web packages and the shared one into their dist folders, which apps from npm get; React Native, and the examples here, take the sources.
- package-lock.json holds Expo's packages as published by 2026-10-27 (`npm install --before`): those released the day after asked for an expo-constants not yet published, and ExpoModulesJSI didn't compile.

## What the tests show

2026-10-28, on the iPhone 17 simulator, an Android 16 tablet emulator and Chrome on a Mac:

- **Every script renders,** in the reader's own fonts: Hebrew with points and cantillation, polytonic Greek, vocalized Arabic, Persian (on iOS and Android; the web example has none) and the Quran with its tajweed colors.
- **Reading along** matches verses across numbering schemes, inline and side by side, in reading lists too; right-to-left books run their columns and pages from the right.
- **Speed:** the Psalms in Hebrew, English and German, a verse per line (7,449 verses), side by side, show their first pages after 0.6 s on iOS and 0.5 s on Android, and are laid out in full after 1.0 s and 1.7 s; the English Psalms alone, a verse per line, take 0.17 s in the browser.

## Open

- Android lays out all after its first pages on one thread; iOS shares that out among the cores.
- In pages, the web reader lays out the whole text at once, to count them; in a scroll it holds the whole text, but lays out only what is in sight.
- Side by side in pages, the row after one cut over pages starts on a page of its own.
- Not on npm yet: `npm run build` and `build:native` make what the packages would publish.
