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
 * voice starts at once; each after it twice as long as the one before, up to what the engine takes,
 * so few sentences are cut apart – as long as the voice starts them at once. Each is given as the one
 * before it sounds, so the engine can prepare it. It tells the reader the word the voice comes to, as
 * the engine reports it. Only voices on the device speak: a network voice would send the text away.
 */
class ReadAloud(context: Context) {
  /** The voice comes to a word of an utterance. */
  var onWord: ((Utterance, Word) -> Unit)? = null

  /** "speaking", "paused" or "stopped"; after a start, how long until the first word sounded, in milliseconds; the languages skipped for want of a voice. */
  var onChange: ((Map<String, Any>) -> Unit)? = null

  /** A voice per language, by name; otherwise the engine's best on the device. */
  var voices: Map<String, String> = emptyMap()

  /** How fast the voices read, as a multiple of their own rate: from 0.5 to 2. */
  var rate = 1.0

  var state = "stopped"
    private set

  private val context = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private var ready = false

  /** A start that waits for the engine. */
  private var waiting: (() -> Unit)? = null
  private var speech: Speech? = null

  /** The utterances given to the engine and not yet done, by id, in order. */
  private val queued = LinkedHashMap<String, Queued>()
  private var count = 0
  private var voiceSet: Voice? = null
  private var started: Long? = null
  private val unvoiced = sortedSetOf<String>()

  /** How long the next utterance may be. */
  private var nextLength = FIRST_LENGTH

  /** When the last utterance ended, and in which voice: the next one in it sounds at once. */
  private var ended: Pair<Long, String>? = null

  /** An utterance as the core made it, in a voice; whether it sounded yet. */
  private class Queued(val utterance: Utterance, val voice: String) {
    var sounded = false
  }

  /** Reads the passages from the word at [from], or from their start. */
  fun play(references: List<Reference>, companions: List<String>, along: Boolean, from: WordPosition?) {
    silence()
    val speech = Speech(references, companions, along, from)
    this.speech = speech
    started = SystemClock.elapsedRealtime()
    change("speaking")
    withEngine {
      enqueue()
      enqueue()
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
    nextLength = FIRST_LENGTH
    ended = null
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

  /** Gives the engine the next utterance with a voice. */
  private fun enqueue() {
    val engine = engine ?: return
    while (true) {
      val utterance = speech?.next(nextLength.toUInt()) ?: return
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
      queued[id] = Queued(utterance, voice.name)
      // Each utterance takes the rate set as it is given.
      engine.setSpeechRate(engineRate())
      engine.speak(utterance.text, TextToSpeech.QUEUE_ADD, Bundle(), id)
      nextLength = minOf(nextLength * 2, promptLengths[voice.name] ?: TextToSpeech.getMaxSpeechInputLength())
      return
    }
  }

  /**
   * The engine's rate for [rate]. Google's engine slows down less than it is told: on an emulator (2026-10-29), it read English at 0.69
   * times its speed at 0.5, and at 0.53 times at 0.25 – about 0.37 + 0.63 times the rate – but twice as fast at 2. Other engines get the
   * multiple as it is.
   */
  private fun engineRate(): Float {
    val rate = rate.coerceIn(0.5, 2.0)
    if (rate >= 1 || engine?.defaultEngine != GOOGLE_ENGINE) return rate.toFloat()
    return ((rate - 0.37) / 0.63).toFloat()
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
      val now = SystemClock.elapsedRealtime()
      main.post {
        val queued = queued[id] ?: return@post
        val utterance = queued.utterance
        started?.let {
          started = null
          change("speaking", mapOf("firstSound" to (now - it).toDouble()))
        }
        if (!queued.sounded) {
          queued.sounded = true
          sounded(queued, now)
          if (this@ReadAloud.queued.size < 2) enqueue()
        }
        // The word the range starts in, or the first, if it starts before any.
        val word = utterance.words.lastOrNull { it.start.toInt() <= start } ?: utterance.words.firstOrNull()
        word?.let { onWord?.invoke(utterance, it) }
      }
    }

    override fun onDone(id: String) {
      val now = SystemClock.elapsedRealtime()
      main.post {
        val voice = queued[id]?.voice ?: return@post
        finished(id)
        ended = now to voice
      }
    }

    @Deprecated("Deprecated in Java")
    override fun onError(id: String) {
      main.post { finished(id) }
    }

    override fun onError(id: String, errorCode: Int) {
      main.post { finished(id) }
    }
  }

  /** An utterance sounded, at [time]: if it was late after the one before in its voice, the voice prepares an utterance before it speaks, and the next are shorter. */
  private fun sounded(queued: Queued, time: Long) {
    val (end, voice) = ended ?: return
    ended = null
    val wait = time - end
    if (voice != queued.voice || wait <= LATE_MILLISECONDS) return
    val length = (queued.utterance.text.length * LATE_MILLISECONDS.toDouble() / wait).toInt().coerceAtLeast(FIRST_LENGTH)
    promptLengths[voice] = minOf(promptLengths[voice] ?: Int.MAX_VALUE, length)
    nextLength = minOf(nextLength, length)
  }

  private fun finished(id: String) {
    queued.remove(id) ?: return
    ended = null
    // For a voice that reports no words, the next is given now.
    if (queued.isEmpty()) repeat(2) { enqueue() }
    if (queued.isEmpty()) stop()
  }

  companion object {
    /** The first utterance's length, in UTF-16 code units. */
    private const val FIRST_LENGTH = 200

    private const val GOOGLE_ENGINE = "com.google.android.tts"

    /**
     * An utterance that sounds this late after the one before, in milliseconds, started late – a voice
     * that prepares as it speaks takes 30 – and the voice's next take as long as it starts in that.
     */
    private const val LATE_MILLISECONDS = 300L

    /** The longest utterance each voice starts at once, by name, where that is shorter than the engine takes: a voice that prepares all of an utterance before it speaks takes the longer to start, the longer it is. */
    private val promptLengths = mutableMapOf<String, Int>()

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
