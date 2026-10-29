package de.schaefchens.scriptura

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.lang.ref.WeakReference

/**
 * The system's media controls for a reader reading aloud – its notification and the lock screen – as a media service, which keeps the
 * app going while it reads in the background. Their buttons play and pause the reader, or move it by a verse. One reader at a time has
 * them: the last that read aloud with something to show there. The app declares the service in its manifest – the config plugin's
 * backgroundAudio does – or the reader pauses as the app goes to the background.
 */
@OptIn(UnstableApi::class)
class ReadingService : MediaSessionService() {
  private var session: MediaSession? = null

  // Added at once, not when a controller connects – none does – so the service puts it in its notification and the foreground.
  override fun onCreate() {
    super.onCreate()
    session = MediaSession.Builder(this, Reading).build().also(::addSession)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

  override fun onDestroy() {
    session?.release()
    session = null
    super.onDestroy()
  }

  companion object {
    /** Whether the app declares the service: only then can a reader read on in the background. */
    fun declared(context: Context) = runCatching {
      context.packageManager.getServiceInfo(android.content.ComponentName(context, ReadingService::class.java), 0)
    }.isSuccess

    /** Shows [shown] for [reader], reading aloud or paused – or with nothing to show, or stopped, nothing of it. */
    fun show(context: Context, reader: ReaderView, shown: NowPlayingRecord?, state: String) {
      if (shown != null && state != "stopped") {
        if (Reading.reader?.get() == null && declared(context)) runCatching { context.startService(Intent(context, ReadingService::class.java)) }
        Reading.show(reader, shown, state == "speaking")
      } else if (Reading.reader?.get() === reader) {
        Reading.hide()
        context.stopService(Intent(context, ReadingService::class.java))
      }
    }
  }
}

/**
 * The reader reading aloud, as the media session sees it: a player of one item, the reading, which plays or is paused. The verses
 * before and after stand as the items before and after it, so the controls' previous and next buttons – and a headset's – move it by a
 * verse.
 */
@OptIn(UnstableApi::class)
internal object Reading : SimpleBasePlayer(Looper.getMainLooper()) {
  var reader: WeakReference<ReaderView>? = null
    private set
  private var shown: NowPlayingRecord? = null
  private var playing = false

  fun show(reader: ReaderView, shown: NowPlayingRecord, playing: Boolean) {
    this.reader = WeakReference(reader)
    this.shown = shown
    this.playing = playing
    invalidateState()
  }

  fun hide() {
    reader = null
    shown = null
    playing = false
    invalidateState()
  }

  override fun getState(): State {
    val commands = Player.Commands.Builder()
      .addAll(COMMAND_PLAY_PAUSE, COMMAND_STOP, COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_PREVIOUS, COMMAND_GET_CURRENT_MEDIA_ITEM, COMMAND_GET_METADATA, COMMAND_GET_TIMELINE)
      .build()
    val state = State.Builder().setAvailableCommands(commands).setPlayWhenReady(playing, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
    val shown = shown ?: return state.setPlaybackState(STATE_IDLE).build()
    val metadata = MediaMetadata.Builder().setTitle(shown.title).setArtist(shown.subtitle).build()
    val items = listOf("verse before", "reading", "verse after").map { MediaItemData.Builder(it).setMediaMetadata(metadata).build() }
    return state.setPlaybackState(STATE_READY).setPlaylist(items).setCurrentMediaItemIndex(1).build()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    reader?.get()?.let { if (playWhenReady) it.play() else it.pause() }
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> {
    reader?.get()?.stop()
    return Futures.immediateVoidFuture()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when {
      mediaItemIndex == 2 -> reader?.get()?.move("verse+1")
      mediaItemIndex == 0 -> reader?.get()?.move("verse-1")
    }
    return Futures.immediateVoidFuture()
  }
}
