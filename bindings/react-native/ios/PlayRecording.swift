import AVFoundation
import UIKit

/// Plays takes of recordings: from a take's start to its end, telling the word the audio comes to,
/// as the take's timings have it, at every frame of the screen. A take of the audio already loaded
/// seeks in it. Audio under a scheme an app registered a source for comes from that source, piece
/// by piece (see ``AudioSources``). The voice keeps its pitch at every rate. It plays in the app's audio session, set to
/// spoken audio for playback, so the silent switch doesn't mute it; reading on in the background
/// needs the app's audio background mode.
final class PlayRecording: NSObject {
  /// The audio comes to a word of a take.
  var onWord: ((Take, TimedWord) -> Void)?
  /// The audio sounds, after a start or a seek, at the time given, as CACurrentMediaTime counts it.
  var onSound: ((CFTimeInterval) -> Void)?
  var onEnd: (() -> Void)?
  /// Something else took the audio – a call, another app – or the headphones were taken off: it paused.
  var onPause: (() -> Void)?
  var onError: (() -> Void)?
  /// How fast it plays: from 0.5 to 2.
  var rate = 1.0

  private let player = AVPlayer()
  private var take: Take?
  /// The audio loaded, as the take gave it.
  private var audio: String?
  /// The word the audio came to last, as its index in the take.
  private var word = -1
  private var link: CADisplayLink?
  /// Where the audio was as it was started, until it moves on from there: then it sounds.
  private var startedAt: Double?
  private var observers: [NSObjectProtocol] = []
  private var status: NSKeyValueObservation?
  /// What answers the player for audio from a source: the asset holds it only weakly.
  private var loader: SourceLoader?

  override init() {
    super.init()
    // A file on the device plays at once, without waiting to buffer.
    player.automaticallyWaitsToMinimizeStalling = false
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] notification in
        guard let self, notification.object as? AVPlayerItem === player.currentItem, take != nil else { return }
        end()
      },
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
        let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
        if began { self?.paused() }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.paused() }
      },
    ]
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    link?.invalidate()
  }

  func play(_ take: Take) {
    self.take = take
    word = -1
    guard prepare(take) else { return failed() }
    resume(from: Double(take.start) / 1000)
  }

  /// Loads a take's audio and goes to its start, to play it at once as its turn comes; false if it
  /// names no audio.
  @discardableResult
  func prepare(_ take: Take) -> Bool {
    // Audio that failed to load is loaded anew.
    if audio != take.audio || player.currentItem?.status == .failed {
      guard let url = URL(string: take.audio), url.scheme != nil else { return false }
      let asset = AVURLAsset(url: url)
      loader = AudioSources.source(for: url).map(SourceLoader.init)
      asset.resourceLoader.setDelegate(loader, queue: SourceLoader.queue)
      let item = AVPlayerItem(asset: asset)
      // Made for speech: it keeps a voice's pitch and clarity as the rate changes.
      item.audioTimePitchAlgorithm = .timeDomain
      status = item.observe(\.status) { [weak self] item, _ in
        if item.status == .failed { DispatchQueue.main.async { self?.failed() } }
      }
      player.replaceCurrentItem(with: item)
      audio = take.audio
    }
    player.currentItem?.forwardPlaybackEndTime = take.end.map { CMTime(value: CMTimeValue($0), timescale: 1000) } ?? .invalid
    player.seek(to: CMTime(value: CMTimeValue(take.start), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
    return true
  }

  /// Goes on where it paused.
  func resume(from time: Double? = nil) {
    guard take != nil else { return }
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    try? AVAudioSession.sharedInstance().setActive(true)
    startedAt = time ?? player.currentTime().seconds
    player.playImmediately(atRate: Float(min(max(rate, 0.5), 2)))
    if link == nil {
      link = CADisplayLink(target: self, selector: #selector(follow))
      link?.add(to: .main, forMode: .common)
    }
  }

  func pause() {
    link?.invalidate()
    link = nil
    player.pause()
  }

  func stop() {
    pause()
    take = nil
  }

  /// A new rate, at once.
  func setRate(_ rate: Double) {
    self.rate = rate
    if player.rate > 0 {
      player.rate = Float(min(max(rate, 0.5), 2))
    }
  }

  /// Tells the word the audio is at, while it plays, and ends the take where it ends.
  @objc private func follow() {
    guard let take else { return }
    let time = player.currentTime().seconds
    // As a seek starts, the time may creep: it counts as sounding once it ran on 50 ms, from 50 ms before.
    if let startedAt, time >= startedAt + 0.05 {
      self.startedAt = nil
      onSound?(CACurrentMediaTime() - 0.05 / Double(max(player.rate, 0.5)))
    }
    let milliseconds = time * 1000
    if let end = take.end, milliseconds >= Double(end) {
      return self.end()
    }
    // The last word that starts by now.
    var low = 0
    var high = take.words.count
    while low < high {
      let middle = (low + high) / 2
      if Double(take.words[middle].start) <= milliseconds { low = middle + 1 } else { high = middle }
    }
    if low - 1 >= 0, low - 1 != word {
      word = low - 1
      onWord?(take, take.words[word])
    }
  }

  private func paused() {
    guard take != nil, link != nil else { return }
    pause()
    onPause?()
  }

  private func end() {
    guard take != nil else { return }
    stop()
    onEnd?()
  }

  private func failed() {
    guard take != nil else { return }
    stop()
    audio = nil
    onError?()
  }
}
