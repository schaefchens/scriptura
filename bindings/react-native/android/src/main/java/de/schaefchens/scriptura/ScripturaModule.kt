package de.schaefchens.scriptura

import android.graphics.Color
import android.net.Uri
import de.schaefchens.scriptura.core.BooksException
import de.schaefchens.scriptura.core.RecordingsException
import de.schaefchens.scriptura.core.addBooks
import de.schaefchens.scriptura.core.addRecordings
import de.schaefchens.scriptura.core.books
import de.schaefchens.scriptura.core.clearBooks
import de.schaefchens.scriptura.core.clearRecordings
import de.schaefchens.scriptura.core.recordings
import de.schaefchens.scriptura.core.removeBooks
import de.schaefchens.scriptura.core.removeRecordings
import expo.modules.kotlin.Promise
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

/** Where a word stands, as JS passes it to jump to. */
class WordPositionRecord : Record {
  @Field val passage: Int = 0
  @Field val book: String = ""
  @Field val chapter: Int = 0
  @Field val verse: Int = 0
  @Field val word: Int = 0
}

/** What the system's media controls show of the reader reading aloud. */
class NowPlayingRecord : Record {
  @Field val title: String = ""
  @Field val subtitle: String? = null
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

    // Recordings of chapters, read here too; an audio that is no URI is found next to them.
    AsyncFunction("addRecordings") { source: BooksSource ->
      val ids = try {
        addRecordings(bytesOf(source, RECORDINGS), baseOf(source))
      } catch (error: RecordingsException) {
        throw CodedException("ERR_SCRIPTURA_RECORDINGS", error.message, error)
      }
      ReaderView.recordingsChanged()
      ids
    }.runOnQueue(Queues.MAIN)

    Function("recordings") {
      recordings().map {
        mapOf("id" to it.id, "voice" to it.voice, "name" to it.name, "book" to it.book, "chapter" to it.chapter.toInt(), "misfit" to it.misfit)
      }
    }

    AsyncFunction("removeRecordings") { ids: List<String> ->
      removeRecordings(ids)
      ReaderView.recordingsChanged()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearRecordings") {
      clearRecordings()
      ReaderView.recordingsChanged()
    }.runOnQueue(Queues.MAIN)

    // The voices that can read aloud: their names and languages.
    AsyncFunction("speechVoices") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.resolve(emptyList<Any>())
      ReadAloud.voiceList(context, promise::resolve)
    }

    View(ReaderView::class) {
      Events("onWordChange", "onLaidOut", "onSpeechChange")

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
      Prop("voices") { view: ReaderView, voices: Map<String, String>? ->
        view.voices = voices ?: emptyMap()
      }
      Prop("speakAlong", false) { view: ReaderView, speakAlong: Boolean ->
        view.speakAlong = speakAlong
      }
      Prop("speechRate", 1.0) { view: ReaderView, speechRate: Double ->
        view.speechRate = speechRate
      }
      Prop("recordedVoices") { view: ReaderView, voices: List<String>? ->
        view.recordedVoices = voices
      }
      Prop("nowPlaying") { view: ReaderView, nowPlaying: NowPlayingRecord? ->
        view.nowPlaying = nowPlaying
      }
      OnViewDidUpdateProps { view: ReaderView ->
        view.render()
      }

      AsyncFunction("move") { view: ReaderView, step: String ->
        view.move(step)
      }
      AsyncFunction("jump") { view: ReaderView, position: WordPositionRecord ->
        view.jump(ReaderView.WordPlace(position.passage, position.book, position.chapter, position.verse, position.word))
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("play") { view: ReaderView ->
        view.play()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("pause") { view: ReaderView ->
        view.pause()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("stop") { view: ReaderView ->
        view.stop()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("follow") { view: ReaderView ->
        view.follow()
      }.runOnQueue(Queues.MAIN)
      AsyncFunction("turn") { view: ReaderView, forward: Boolean ->
        view.turn(forward)
      }.runOnQueue(Queues.MAIN)
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

  private fun bytesOf(source: BooksSource, folder: String = BOOKS): ByteArray {
    source.json?.let { return it.toByteArray() }
    val context = appContext.reactContext ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "No context to read books in", null)
    source.asset?.let { asset ->
      return runCatching { context.assets.open("$folder/$asset").use { it.readBytes() } }
        .getOrElse { throw CodedException("ERR_SCRIPTURA_BOOKS", "The app bundles no $asset in $folder", it) }
    }
    val uri = source.uri?.let(Uri::parse) ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "Books and recordings need a uri, an asset or json", null)
    val stream = if (uri.scheme == null) java.io.File(uri.toString()).inputStream() else context.contentResolver.openInputStream(uri)
    return stream?.use { it.readBytes() } ?: throw CodedException("ERR_SCRIPTURA_BOOKS", "Can't read $uri", null)
  }

  /** Where recordings came from, for the audio they name relative to it: the app's folder of them, or a file's. */
  private fun baseOf(source: BooksSource): String? {
    if (source.asset != null) return "asset:///$RECORDINGS/"
    val uri = source.uri?.let(Uri::parse) ?: return null
    val file = if (uri.scheme == null) Uri.fromFile(java.io.File(uri.toString())) else uri
    return file.buildUpon().path(file.path?.substringBeforeLast('/', "")).build().toString()
  }

  private companion object {
    /** Where the app bundles books, and recordings: see the config plugin. */
    const val BOOKS = "scriptura-books"
    const val RECORDINGS = "scriptura-recordings"
  }
}
