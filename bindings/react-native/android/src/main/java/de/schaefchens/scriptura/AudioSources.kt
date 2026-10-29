package de.schaefchens.scriptura

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.TransferListener
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Audio an app keeps where no file is – in encrypted storage, say – which the reader's players read piece by piece as they play it, so
 * that it is never written out whole. The app registers a source for a URI scheme of its own and names the audio in its recordings by URIs
 * of that scheme, ending in the audio's file extension, such as vault:///17.m4a.
 */
interface AudioSource {
  /** How long the audio at [uri] is, in bytes; null if there is no such audio. */
  fun length(uri: Uri): Long?

  /** Bytes [start] to [end] of the audio at [uri], as far as it reaches; null if they can't be read. Called on a thread of the players', never the main one. */
  fun read(uri: Uri, start: Long, end: Long): ByteArray?
}

/** The audio sources an app registered, by URI scheme. */
object AudioSources {
  private val sources = ConcurrentHashMap<String, AudioSource>()

  fun register(scheme: String, source: AudioSource) {
    sources[scheme.lowercase()] = source
  }

  fun unregister(scheme: String) {
    sources.remove(scheme.lowercase())
  }

  internal fun source(uri: Uri) = uri.scheme?.lowercase()?.let(sources::get)
}

/** Media3's way to the audio: from a registered source, in pieces of a quarter mebibyte, or else from wherever Media3 finds it. */
@OptIn(UnstableApi::class)
internal class SourcedDataSource(private val default: DataSource) : DataSource {
  private var source: AudioSource? = null
  private var uri: Uri? = null
  private var position = 0L
  private var remaining = 0L
  private var piece = ByteArray(0)
  private var used = 0

  class Factory(context: Context) : DataSource.Factory {
    private val default = DefaultDataSource.Factory(context.applicationContext)

    override fun createDataSource() = SourcedDataSource(default.createDataSource())
  }

  override fun addTransferListener(transferListener: TransferListener) = default.addTransferListener(transferListener)

  override fun open(dataSpec: DataSpec): Long {
    val source = AudioSources.source(dataSpec.uri) ?: return default.open(dataSpec)
    val length = source.length(dataSpec.uri) ?: throw FileNotFoundException("No audio at ${dataSpec.uri}")
    this.source = source
    uri = dataSpec.uri
    position = dataSpec.position
    remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else length - position
    piece = ByteArray(0)
    used = 0
    return remaining
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    val source = source ?: return default.read(buffer, offset, length)
    if (length == 0) return 0
    if (remaining == 0L) return C.RESULT_END_OF_INPUT
    if (used == piece.size) {
      piece = source.read(uri!!, position, position + minOf(PIECE, remaining)) ?: throw IOException("Can't read the audio at $uri")
      used = 0
      if (piece.isEmpty()) return C.RESULT_END_OF_INPUT
    }
    val n = minOf(length, piece.size - used)
    piece.copyInto(buffer, offset, used, used + n)
    used += n
    position += n
    remaining -= n
    return n
  }

  override fun getUri(): Uri? = if (source != null) uri else default.uri

  override fun close() {
    if (source == null) return default.close()
    source = null
    piece = ByteArray(0)
  }

  private companion object {
    const val PIECE = 256 * 1024L
  }
}
