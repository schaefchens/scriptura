package de.schaefchens.scriptura

import android.content.Context
import android.os.SystemClock
import android.view.Choreographer
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import de.schaefchens.scriptura.core.Take
import de.schaefchens.scriptura.core.TimedWord

/**
 * Plays takes of recordings, with Media3's player: from a take's start to its end, telling the word the audio comes to, as the take's
 * timings have it, at every frame of the screen. A take of the audio already loaded seeks in it, to the very sample. The voice keeps its
 * pitch at every rate. It plays as spoken media, taking the audio focus while it plays, and pauses when another app takes it for good
 * or the headphones come off.
 */
class PlayRecording(context: Context) {
  /** The audio comes to a word of a take. */
  var onWord: ((Take, TimedWord) -> Unit)? = null

  /** The audio sounds, after a start or a seek, at the time given, as SystemClock.elapsedRealtime counts it. */
  var onSound: ((Double) -> Unit)? = null
  var onEnd: (() -> Unit)? = null

  /** Another app took the audio, or the headphones came off: it paused. */
  var onPause: (() -> Unit)? = null
  var onError: (() -> Unit)? = null

  /** How fast it plays: from 0.5 to 2, a new rate at once. */
  var rate = 1.0
    set(value) {
      field = value
      player.playbackParameters = PlaybackParameters(value.coerceIn(0.5, 2.0).toFloat())
    }

  private val player: ExoPlayer = ExoPlayer.Builder(context.applicationContext)
    .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
    .setHandleAudioBecomingNoisy(true)
    .build()
  private var take: Take? = null

  /** The audio loaded, as the take gave it. */
  private var audio: String? = null

  /** The word the audio came to last, as its index in the take. */
  private var word = -1
  private var following = false

  /** Where the audio was as it was started, until it moves on from there: then it sounds. */
  private var startedAt: Long? = null

  /**
   * Where the player last said the audio is, and when; and where it was taken to be since. Some devices report it only every quarter
   * second – the emulator's audio track moves its play head in such steps – so between reports it moves on at the rate, never back.
   */
  private var reported = -1L to 0L
  private var estimated = 0L

  init {
    player.addListener(object : Player.Listener {
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED && take != null) end()
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        val away = reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS || reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY
        if (!playWhenReady && away && take != null) {
          stopFollowing()
          onPause?.invoke()
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        // Loaded anew as it next plays.
        audio = null
        if (take == null) return
        stop()
        onError?.invoke()
      }
    })
  }

  fun play(take: Take) {
    prepare(take)
    this.take = take
    word = -1
    resume(take.start.toLong())
  }

  /** Loads a take's audio and goes to its start, to play it at once as its turn comes. */
  fun prepare(take: Take) {
    if (audio != take.audio) {
      player.setMediaItem(MediaItem.fromUri(take.audio))
      player.prepare()
      audio = take.audio
    }
    player.seekTo(take.start.toLong())
  }

  /** Goes on where it paused. */
  fun resume(from: Long = player.currentPosition) {
    if (take == null) return
    startedAt = from
    reported = -1L to 0L
    estimated = from
    player.play()
    if (!following) {
      following = true
      Choreographer.getInstance().postFrameCallback(follow)
    }
  }

  fun pause() {
    stopFollowing()
    player.pause()
  }

  fun stop() {
    pause()
    take = null
  }

  fun release() {
    stop()
    player.release()
  }

  private fun stopFollowing() {
    following = false
    Choreographer.getInstance().removeFrameCallback(follow)
  }

  /** Tells the word the audio is at, while it plays, and ends the take where it ends. */
  private val follow: Choreographer.FrameCallback = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      val take = take ?: return
      if (!following) return
      val time = position()
      // As a seek starts, the time may creep: it counts as sounding once it ran on 50 ms, from 50 ms before.
      startedAt?.let {
        if (player.isPlaying && time >= it + 50) {
          startedAt = null
          onSound?.invoke(SystemClock.elapsedRealtime() - 50 / player.playbackParameters.speed.toDouble())
        }
      }
      val until = take.end
      if (until != null && time >= until.toLong()) return end()
      // The last word that starts by now.
      var low = 0
      var high = take.words.size
      while (low < high) {
        val middle = (low + high) / 2
        if (take.words[middle].start.toLong() <= time) low = middle + 1 else high = middle
      }
      if (low - 1 >= 0 && low - 1 != word) {
        word = low - 1
        onWord?.invoke(take, take.words[word])
      }
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  /** Where the audio is, in milliseconds: see [reported]. */
  private fun position(): Long {
    val position = player.currentPosition
    val now = SystemClock.elapsedRealtime()
    if (position != reported.first || !player.isPlaying) reported = position to now
    val moved = ((now - reported.second) * player.playbackParameters.speed).toLong().coerceAtMost(MOST_MOVED)
    estimated = if (player.isPlaying) maxOf(estimated, position + moved) else position
    return estimated
  }

  private fun end() {
    stop()
    onEnd?.invoke()
  }

  private companion object {
    /** How far the audio is taken to have moved on since the player last said where it is, at most, in milliseconds. */
    const val MOST_MOVED = 500L
  }
}
