import ExpoModulesCore
import UIKit

/// Where books come from: a file, one the app bundles (see the config plugin), or JS itself. Only
/// the last passes their text through JS.
struct BooksSource: Record {
  @Field var uri: String?
  @Field var asset: String?
  @Field var json: String?
}

/// A passage as JS passes it: a reference, never text.
struct PassageRecord: Record {
  @Field var book: String = ""
  @Field var chapter: Int?
  @Field var from: Int?
  @Field var to: Int?
}

/// Where a word stands, as JS passes it to jump to.
struct WordPositionRecord: Record {
  @Field var passage: Int = 0
  @Field var book: String = ""
  @Field var chapter: Int = 0
  @Field var verse: Int = 0
  @Field var word: Int = 0
}

/// The reader's colors. Text takes the color of its role, if it has one: a verse number, a heading,
/// a tajweed rule.
struct ReaderColors: Record {
  @Field var background: UIColor = .white
  @Field var text: UIColor = .black
  @Field var highlight: UIColor = UIColor(red: 1, green: 0.88, blue: 0.51, alpha: 1)
  @Field var roles: [String: UIColor] = [:]
}

public class ScripturaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Scriptura")

    // Read here, from where the host says: JS learns the books' ids, not their text.
    AsyncFunction("addBooks") { (source: BooksSource) throws -> [String] in
      let ids = try addBooks(json: try Self.data(of: source))
      Self.booksChanged()
      return ids
    }

    Function("books") {
      books().map { book in
        ["id": book.id, "code": book.code, "title": book.title, "work": book.work, "language": book.language, "direction": book.direction]
      }
    }

    AsyncFunction("removeBooks") { (ids: [String]) in
      removeBooks(ids: ids)
      Self.booksChanged()
    }

    AsyncFunction("clearBooks") {
      clearBooks()
      Self.booksChanged()
    }

    // Recordings of chapters, read here too; an audio that is no URI is found next to them.
    AsyncFunction("addRecordings") { (source: BooksSource) throws -> [String] in
      let ids = try addRecordings(json: try Self.data(of: source, folder: Self.recordingsFolder), base: Self.base(of: source))
      Self.recordingsChanged()
      return ids
    }

    Function("recordings") {
      recordings().map { ["id": $0.id, "voice": $0.voice, "book": $0.book, "chapter": $0.chapter] }
    }

    AsyncFunction("removeRecordings") { (ids: [String]) in
      removeRecordings(ids: ids)
      Self.recordingsChanged()
    }

    AsyncFunction("clearRecordings") {
      clearRecordings()
      Self.recordingsChanged()
    }

    // The voices that can read aloud: their identifiers, names and languages.
    AsyncFunction("speechVoices") {
      ReadAloud.voiceList()
    }

    View(ReaderView.self) {
      Events("onWordChange", "onLaidOut", "onSpeechChange")

      Prop("passages") { (view: ReaderView, passages: [PassageRecord]?) in
        view.passages = passages ?? []
      }
      Prop("fontSize", 28.0) { (view: ReaderView, fontSize: Double) in
        view.fontSize = fontSize
      }
      Prop("paging", "scroll") { (view: ReaderView, paging: String) in
        view.paging = paging
      }
      Prop("columns", 1) { (view: ReaderView, columns: Int) in
        view.columns = columns
      }
      Prop("colors") { (view: ReaderView, colors: ReaderColors?) in
        view.colors = colors ?? ReaderColors()
      }
      Prop("font", "sans") { (view: ReaderView, font: String) in
        view.font = font
      }
      Prop("fonts") { (view: ReaderView, fonts: [String: String]?) in
        view.fonts = fonts ?? [:]
      }
      Prop("lineSpacing", 1.0) { (view: ReaderView, lineSpacing: Double) in
        view.lineSpacing = lineSpacing
      }
      Prop("sideMargin", 16.0) { (view: ReaderView, margin: Double) in
        view.margin = margin
      }
      Prop("versePerLine", false) { (view: ReaderView, versePerLine: Bool) in
        view.versePerLine = versePerLine
      }
      Prop("companions") { (view: ReaderView, companions: [String]?) in
        view.companions = companions ?? []
      }
      Prop("parallel", "inline") { (view: ReaderView, parallel: String) in
        view.parallel = parallel
      }
      Prop("voices") { (view: ReaderView, voices: [String: String]?) in
        view.voices = voices ?? [:]
      }
      Prop("speakAlong", false) { (view: ReaderView, speakAlong: Bool) in
        view.speakAlong = speakAlong
      }
      Prop("speechRate", 1.0) { (view: ReaderView, speechRate: Double) in
        view.speechRate = speechRate
      }
      Prop("recordedVoices") { (view: ReaderView, voices: [String]?) in
        view.recordedVoices = voices
      }
      OnViewDidUpdateProps { (view: ReaderView) in
        view.render()
      }

      AsyncFunction("move") { (view: ReaderView, step: String) in
        view.move(step)
      }
      AsyncFunction("jump") { (view: ReaderView, position: WordPositionRecord) -> Bool in
        view.jump(to: WordPlace(passage: UInt32(position.passage), book: position.book, chapter: UInt32(position.chapter),
                                verse: UInt32(position.verse), index: UInt32(position.word)))
      }
      AsyncFunction("play") { (view: ReaderView) in
        view.play()
      }
      AsyncFunction("pause") { (view: ReaderView) in
        view.pause()
      }
      AsyncFunction("stop") { (view: ReaderView) in
        view.stop()
      }
      AsyncFunction("follow") { (view: ReaderView) in
        view.follow()
      }
      AsyncFunction("turn") { (view: ReaderView, forward: Bool) in
        view.turn(forward: forward)
      }
      // The same as a tap at that point, so the hit test can be tried without a finger.
      AsyncFunction("tapAt") { (view: ReaderView, x: Double, y: Double) in
        view.tap(at: CGPoint(x: x, y: y))
      }
      // What a screen reader finds, so that can be checked without one.
      AsyncFunction("accessibilityElementsInSight") { (view: ReaderView) in
        view.accessibilityElementsInSight()
      }
    }
  }

  /// Where the app bundles books, and recordings: see the config plugin.
  private static let booksFolder = "scriptura-books"
  private static let recordingsFolder = "scriptura-recordings"

  private static func data(of source: BooksSource, folder: String = booksFolder) throws -> Data {
    if let json = source.json {
      return Data(json.utf8)
    }
    if let asset = source.asset {
      guard let url = Bundle.main.url(forResource: asset, withExtension: nil, subdirectory: folder) else {
        throw Exception(name: "ERR_SCRIPTURA_BOOKS", description: "The app bundles no \(asset) in \(folder)")
      }
      return try Data(contentsOf: url)
    }
    guard let url = fileURL(of: source) else {
      throw Exception(name: "ERR_SCRIPTURA_BOOKS", description: "Books and recordings need a uri, an asset or json")
    }
    return try Data(contentsOf: url)
  }

  private static func fileURL(of source: BooksSource) -> URL? {
    guard let uri = source.uri, let url = URL(string: uri) else { return nil }
    return url.isFileURL ? url : URL(fileURLWithPath: uri)
  }

  /// Where recordings came from, for the audio they name relative to it: the bundle's folder of them,
  /// or a file's.
  private static func base(of source: BooksSource) -> String? {
    if source.asset != nil {
      return Bundle.main.url(forResource: recordingsFolder, withExtension: nil)?.absoluteString
    }
    return source.json == nil ? fileURL(of: source)?.deletingLastPathComponent().absoluteString : nil
  }

  private static func booksChanged() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: ReaderView.booksChanged, object: nil)
    }
  }

  private static func recordingsChanged() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: ReaderView.recordingsChanged, object: nil)
    }
  }
}
