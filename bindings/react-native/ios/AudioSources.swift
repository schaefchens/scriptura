import AVFoundation
import UniformTypeIdentifiers

/// Audio an app keeps where no file is – in encrypted storage, say – which the reader's players read
/// piece by piece as they play it, so that it is never written out whole. The app registers a source
/// for a URI scheme of its own and names the audio in its recordings by URIs of that scheme, ending
/// in the audio's file extension, such as vault:///17.m4a.
public protocol AudioSource: AnyObject {
  /// How long the audio at `uri` is, in bytes; nil if there is no such audio.
  func length(of uri: URL) -> Int64?
  /// Bytes `range` of the audio at `uri`, as far as it reaches; nil if they can't be read. Called on
  /// a queue of the players', never the main one.
  func read(_ uri: URL, range: Range<Int64>) -> Data?
}

/// The audio sources an app registered, by URI scheme.
public enum AudioSources {
  private static var sources: [String: AudioSource] = [:]
  private static let lock = NSLock()

  public static func register(_ source: AudioSource, scheme: String) {
    lock.withLock { sources[scheme.lowercased()] = source }
  }

  public static func unregister(scheme: String) {
    _ = lock.withLock { sources.removeValue(forKey: scheme.lowercased()) }
  }

  static func source(for url: URL) -> AudioSource? {
    guard let scheme = url.scheme?.lowercased() else { return nil }
    return lock.withLock { sources[scheme] }
  }
}

/// Answers a player's requests for audio from a source, in pieces of at most a mebibyte: the player
/// asks again for what it needs next.
final class SourceLoader: NSObject, AVAssetResourceLoaderDelegate {
  static let queue = DispatchQueue(label: "de.schaefchens.scriptura.audio-source")
  private static let piece: Int64 = 256 * 1024
  private static let mostPerRequest: Int64 = 1024 * 1024

  private let source: AudioSource

  init(_ source: AudioSource) {
    self.source = source
  }

  func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
    guard let url = request.request.url, let length = source.length(of: url) else {
      request.finishLoading(with: NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
      return true
    }
    if let information = request.contentInformationRequest {
      information.contentType = UTType(filenameExtension: url.pathExtension)?.identifier ?? UTType.audio.identifier
      information.contentLength = length
      information.isByteRangeAccessSupported = true
    }
    if let data = request.dataRequest {
      var at = data.currentOffset
      let asked = data.requestsAllDataToEndOfResource ? length : data.requestedOffset + Int64(data.requestedLength)
      let end = min(asked, length, at + Self.mostPerRequest)
      while at < end, !request.isCancelled {
        guard let bytes = source.read(url, range: at..<min(at + Self.piece, end)), !bytes.isEmpty else {
          request.finishLoading(with: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotDecodeContentData))
          return true
        }
        data.respond(with: bytes)
        at += Int64(bytes.count)
      }
    }
    if !request.isCancelled {
      request.finishLoading()
    }
    return true
  }
}
