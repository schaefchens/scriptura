package de.schaefchens.scriptura

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import de.schaefchens.scriptura.core.Reference
import de.schaefchens.scriptura.core.Speech
import de.schaefchens.scriptura.core.Utterance
import de.schaefchens.scriptura.core.Word
import de.schaefchens.scriptura.core.WordPosition
import java.util.Locale

/**
 * Reads passages aloud with the device's voices, a voice for each language: utterances from the
 * core, one after the other, so their text never passes through JS. The first is short, so the
 * voice starts at once; the rest as long as the engine takes, so few sentences are cut apart. It
 * tells the reader the word the voice comes to, as the engine reports it. Only voices on the device
 * speak: a network voice would send the text away.
 */
class ReadAloud(context: Context) {
  /** The voice comes to a word of an utterance. */
  var onWord: ((Utterance, Word) -> Unit)? = null

  /** "speaking", "paused" or "stopped"; after a start, how long until the first word sounded, in milliseconds; the languages skipped for want of a voice. */
  var onChange: ((Map<String, Any>) -> Unit)? = null

  /** A voice per language, by name; otherwise the engine's best on the device. */
  var voices: Map<String, String> = emptyMap()

  var state = "stopped"
    private set

  private val context = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private var ready = false

  /** A start that waits for the engine. */
  private var waiting: (() -> Unit)? = null
  private var speech: Speech? = null

  /** The utterances given to the engine and not yet done, by id, in order, as the core made them. */
  private val queued = LinkedHashMap<String, Utterance>()
  private var count = 0
  private var voiceSet: Voice? = null
  private var started: Long? = null
  private val unvoiced = sortedSetOf<String>()

  /** Reads the passages from the word at [from], or from their start. */
  fun play(references: List<Reference>, companions: List<String>, along: Boolean, from: WordPosition?) {
    silence()
    val speech = Speech(references, companions, along, from)
    this.speech = speech
    started = SystemClock.elapsedRealtime()
    change("speaking")
    withEngine {
      enqueue(FIRST_LENGTH)
      enqueue(TextToSpeech.getMaxSpeechInputLength())
      if (queued.isEmpty()) stop()
    }
  }

  /** The engine can't pause: the voice stops, and play goes on from the word the reader is at. */
  fun pause() {
    if (state != "speaking") return
    silence()
    change("paused")
  }

  /** Stops; the languages skipped for want of a voice go with the news. */
  fun stop() {
    val wasStopped = state == "stopped"
    val skipped = unvoiced.toList()
    silence()
    if (!wasStopped) change("stopped", if (skipped.isEmpty()) emptyMap() else mapOf("unvoiced" to skipped))
  }

  /** Stops, and lets the engine go. */
  fun release() {
    stop()
    engine?.shutdown()
    engine = null
    ready = false
  }

  /** Drops what was to be said, without a word to JS. */
  private fun silence() {
    speech?.close()
    speech = null
    queued.clear()
    waiting = null
    started = null
    unvoiced.clear()
    if (ready) engine?.stop()
    state = "stopped"
  }

  private fun change(state: String, details: Map<String, Any> = emptyMap()) {
    this.state = state
    onChange?.invoke(details + ("state" to state))
  }

  private fun withEngine(start: () -> Unit) {
    if (ready) return start()
    waiting = start
    if (engine != null) return
    voiceSet = null
    engine = TextToSpeech(context) { status -> main.post { engineReady(status == TextToSpeech.SUCCESS) } }
  }

  private fun engineReady(success: Boolean) {
    val start = waiting
    waiting = null
    if (success) {
      ready = true
      engine?.setOnUtteranceProgressListener(progress)
      start?.invoke()
    } else {
      // No engine, as on an emulator without Google's: nothing has a voice.
      engine = null
      if (start == null) return
      val languages = speech?.let(::languagesOf).orEmpty()
      silence()
      change("stopped", mapOf("unvoiced" to languages))
    }
  }

  /** Gives the engine the next utterance with a voice, at most [length] long. */
  private fun enqueue(length: Int) {
    val engine = engine ?: return
    while (true) {
      val utterance = speech?.next(length.toUInt()) ?: return
      val voice = voiceFor(utterance.language)
      if (voice == null) {
        if (unvoiced.add(utterance.language)) change(state, mapOf("unvoiced" to unvoiced.toList()))
        continue
      }
      // Each utterance takes the voice set as it is given.
      if (voice != voiceSet) {
        engine.voice = voice
        voiceSet = voice
      }
      val id = "scriptura-${++count}"
      queued[id] = utterance
      engine.speak(utterance.text, TextToSpeech.QUEUE_ADD, Bundle(), id)
      return
    }
  }

  /** The voice chosen for a language, or the engine's best on the device for it – in the device's country, if it has one there. */
  private fun voiceFor(language: String): Voice? {
    val all = runCatching { engine?.voices }.getOrNull().orEmpty().filter(::onDevice)
    voices[language]?.let { name -> all.firstOrNull { it.name == name }?.let { return it } }
    val wanted = Locale.forLanguageTag(language).language
    val country = Locale.getDefault().country
    return all.filter { it.locale.language == wanted }
      .maxWithOrNull(compareBy<Voice>({ it.locale.country == country }, { it.quality }, { -it.latency }))
  }

  private fun languagesOf(speech: Speech) = generateSequence { speech.next(UInt.MAX_VALUE) }.map { it.language }.toSortedSet().toList()

  private val progress = object : UtteranceProgressListener() {
    override fun onStart(id: String) {}

    override fun onRangeStart(id: String, start: Int, end: Int, frame: Int) {
      main.post {
        val utterance = queued[id] ?: return@post
        started?.let {
          started = null
          change("speaking", mapOf("firstSound" to (SystemClock.elapsedRealtime() - it).toDouble()))
        }
        // The word the range starts in, or the first, if it starts before any.
        val word = utterance.words.lastOrNull { it.start.toInt() <= start } ?: utterance.words.firstOrNull()
        word?.let { onWord?.invoke(utterance, it) }
      }
    }

    override fun onDone(id: String) {
      main.post { finished(id) }
    }

    @Deprecated("Deprecated in Java")
    override fun onError(id: String) {
      main.post { finished(id) }
    }

    override fun onError(id: String, errorCode: Int) {
      main.post { finished(id) }
    }
  }

  private fun finished(id: String) {
    queued.remove(id) ?: return
    enqueue(TextToSpeech.getMaxSpeechInputLength())
    if (queued.isEmpty()) stop()
  }

  companion object {
    /** The first utterance's length, in UTF-16 code units. */
    private const val FIRST_LENGTH = 200

    private fun onDevice(voice: Voice) =
      !voice.isNetworkConnectionRequired && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in voice.features.orEmpty()

    /** The engine's voices on the device, as a list shows them; none without an engine. */
    fun voiceList(context: Context, deliver: (List<Map<String, Any>>) -> Unit) {
      var engine: TextToSpeech? = null
      engine = TextToSpeech(context.applicationContext) { status ->
        val voices = if (status == TextToSpeech.SUCCESS) runCatching { engine?.voices }.getOrNull().orEmpty() else emptySet()
        deliver(
          voices.filter(::onDevice).sortedBy { it.name }.map {
            mapOf("id" to it.name, "name" to it.name, "language" to it.locale.toLanguageTag(), "quality" to it.quality.toString())
          },
        )
        engine?.shutdown()
      }
    }
  }
}
