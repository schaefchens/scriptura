package de.schaefchens.scriptura

import android.graphics.Color
import android.net.Uri
import de.schaefchens.scriptura.core.BooksException
import de.schaefchens.scriptura.core.addBooks
import de.schaefchens.scriptura.core.books
import de.schaefchens.scriptura.core.clearBooks
import de.schaefchens.scriptura.core.removeBooks
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** Where books come from: a file, one the app bundles (see the config plugin), or JS itself. Only the last passes their text through JS. */
class BooksSource : Record {
  @Field val uri: String? = null
  @Field val asset: String? = null
  @Field val json: String? = null
}

/** A passage as JS passes it: a reference, never text. */
class PassageRecord : Record {
  @Field val book: String = ""
  @Field val chapter: Int? = null
  @Field val from: Int? = null
  @Field val to: Int? = null
}

/** The reader's colors. Text takes the color of its role, if it has one: a verse number, a heading, a tajweed rule. */
class ReaderColors : Record {
  @Field val background: Color? = null
  @Field val text: Color? = null
  @Field val highlight: Color? = null
  @Field val roles: Map<String, Color> = emptyMap()
}

class ScripturaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Scriptura")

    // Read here, from where the host says: JS learns the books' ids, not their text.
    AsyncFunction("addBooks") { source: BooksSource ->
      val ids = try {
        addBooks(bytesOf(source))
      } catch (error: BooksException) {
        throw CodedException("ERR_SCRIPTURA_BOOKS", error.message, error)
      }
      ReaderView.booksChanged()
      ids
    }.runOnQueue(Queues.MAIN)

    Function("books") {
      books().map { mapOf("id" to it.id, "code" to it.code, "title" to it.title, "work" to it.work, "language" to it.language, "direction" to it.direction) }
    }

    AsyncFunction("removeBooks") { ids: List<String> ->
      removeBooks(ids)
      ReaderView.booksChanged()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearBooks") {
      clearBooks()
      ReaderView.booksChanged()
    }.runOnQueue(Queues.MAIN)

    View(ReaderView::class) {
      Events("onWordChange", "onLaidOut")

      Prop("passages") { view: ReaderView, passages: List<PassageRecord>? ->
        view.passages = passages ?: emptyList()
      }
      Prop("fontSize", 28.0) { view: ReaderView, fontSize: Double ->
        view.fontSize = fontSize
      }
      Prop("paging", "scroll") { view: ReaderView, paging: String ->
        view.paging = paging
      }
      Prop("columns", 1) { view: ReaderView, columns: Int ->
        view.columns = columns
      }
      Prop("colors") { view: ReaderView, colors: ReaderColors? ->
        view.colors = colors ?: ReaderColors()
      }
      Prop("font", "sans") { view: ReaderView, font: String ->
        view.font = font
      }
      Prop("fonts") { view: ReaderView, fonts: Map<String, String>? ->
        view.fonts = fonts ?: emptyMap()
      }
      Prop("lineSpacing", 1.0) { view: ReaderView, lineSpacing: Double ->
        view.lineSpacing = lineSpacing
      }
      Prop("sideMargin", 16.0) { view: ReaderView, margin: Double ->
        view.margin = margin
      }
      Prop("versePerLine", false) { view: ReaderView, versePerLine: Boolean ->
        view.versePerLine = versePerLine
      }
      Prop("companions") { view: ReaderView, companions: List<String>? ->
        view.companions = companions ?: emptyList()
      }
      Prop("parallel", "inline") { view: ReaderView, parallel: String ->
        view.parallel = parallel
      }
      OnViewDidUpdateProps { view: ReaderView ->
        view.render()
      }

      AsyncFunction("move") { view: ReaderView, step: String ->
        view.move(step)
      }
      // The same as a tap at that point (in dp), so the hit test can be tried without a finger.
      AsyncFunction("tapAt") { view: ReaderView, x: Double, y: Double ->
        val density = view.resources.displayMetrics.density
        view.tap((x * density).toFloat(), (y * density).toFloat())
      }
      // What a screen reader finds, so that can be checked without one.
      AsyncFunction("accessibilityElementsInSight") { view: ReaderView ->
        view.accessibilityElementsInSight()
      }.runOnQueue(Queues.MAIN)
    }
  }

  private fun bytesOf(source: BooksSource): ByteArray {
    source.json?.let { return it.toByteArray() }
    val context = appContext.reactContext ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "No context to read books in", null)
    source.asset?.let { asset ->
      return runCatching { context.assets.open("scriptura-books/$asset").use { it.readBytes() } }
        .getOrElse { throw CodedException("ERR_SCRIPTURA_BOOKS", "The app bundles no books named $asset", it) }
    }
    val uri = source.uri?.let(Uri::parse) ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "Books need a uri, an asset or json", null)
    val stream = if (uri.scheme == null) java.io.File(uri.toString()).inputStream() else context.contentResolver.openInputStream(uri)
    return stream?.use { it.readBytes() } ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "Can't read books from $uri", null)
  }
}
