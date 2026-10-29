import MediaPlayer

/// What the system's media controls show of a reader reading aloud – on the lock screen and in the
/// control center – and what their buttons do to it: play and pause it, or move it by a verse. One
/// reader at a time has them: the last that read aloud with something to show there.
final class NowPlaying {
  static let shared = NowPlaying()

  private weak var reader: ReaderView?
  private var targets: [(command: MPRemoteCommand, target: Any)] = []

  /// Shows `shown` for `reader`, reading or paused, and lets the controls' buttons work it.
  func show(_ shown: NowPlayingRecord, playing: Bool, for reader: ReaderView) {
    if self.reader !== reader {
      self.reader.map(hide(for:))
      take(reader)
    }
    var info: [String: Any] = [MPMediaItemPropertyTitle: shown.title, MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0]
    info[MPMediaItemPropertyArtist] = shown.subtitle
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  /// Shows nothing of `reader` any more, if it shows it.
  func hide(for reader: ReaderView) {
    guard self.reader === reader else { return }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    for (command, target) in targets {
      command.removeTarget(target)
    }
    targets = []
    self.reader = nil
  }

  private func take(_ reader: ReaderView) {
    self.reader = reader
    let center = MPRemoteCommandCenter.shared()
    let actions: [(MPRemoteCommand, (ReaderView) -> Void)] = [
      (center.playCommand, { $0.play() }),
      (center.pauseCommand, { $0.pause() }),
      (center.togglePlayPauseCommand, { $0.playOrPause() }),
      (center.nextTrackCommand, { $0.move("verse+1") }),
      (center.previousTrackCommand, { $0.move("verse-1") }),
    ]
    targets = actions.map { command, act in
      command.isEnabled = true
      let target = command.addTarget { [weak reader] _ in
        guard let reader else { return .noActionableNowPlayingItem }
        act(reader)
        return .success
      }
      return (command, target)
    }
  }
}
