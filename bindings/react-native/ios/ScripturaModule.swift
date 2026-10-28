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

    View(ReaderView.self) {
      Events("onWordChange", "onLaidOut")

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
      OnViewDidUpdateProps { (view: ReaderView) in
        view.render()
      }

      AsyncFunction("move") { (view: ReaderView, step: String) in
        view.move(step)
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

  private static func data(of source: BooksSource) throws -> Data {
    if let json = source.json {
      return Data(json.utf8)
    }
    if let asset = source.asset {
      guard let url = Bundle.main.url(forResource: asset, withExtension: nil, subdirectory: "scriptura") else {
        throw Exception(name: "ERR_SCRIPTURA_BOOKS", description: "The app bundles no books named \(asset)")
      }
      return try Data(contentsOf: url)
    }
    guard let uri = source.uri, let url = URL(string: uri) else {
      throw Exception(name: "ERR_SCRIPTURA_BOOKS", description: "Books need a uri, an asset or json")
    }
    return try Data(contentsOf: url.isFileURL ? url : URL(fileURLWithPath: uri))
  }

  private static func booksChanged() {
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: ReaderView.booksChanged, object: nil)
    }
  }
}
