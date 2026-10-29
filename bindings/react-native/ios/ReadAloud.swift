import AVFoundation

/// Reads passages aloud: chapters with recordings from them, the rest with the device's voices, a
/// voice for each language. It takes the parts from the core one after the other, so their text
/// never passes through JS: a take of a recording plays once the voice has said what it was given.
/// The voice's utterances: the first is short, so the voice starts at once; each after it twice as
/// long as the one before, so few sentences are cut apart – as long as the voice starts them at once.
/// Each is given as the one before it sounds, so the voice can prepare it. It tells the reader the
/// word the voice comes to, as the voice reports it, or a recording's timings have it.
final class ReadAloud: NSObject, AVSpeechSynthesizerDelegate {
  /// The voice, or a recording, comes to a word.
  var onWord: ((WordPlace) -> Void)?
  /// "speaking", "paused" or "stopped"; after a start, how long until the first word sounded, in
  /// milliseconds; the languages skipped for want of a voice; whose recording plays.
  var onChange: (([String: Any]) -> Void)?
  /// A voice per language, by identifier; otherwise the device's for it.
  var voices: [String: String] = [:]
  /// How fast the voices read, as a multiple of their own rate: from 0.5 to 2.
  var rate = 1.0
  /// Whether the voice speaks in the app's audio session, set to spoken audio for playback – so that
  /// it goes on in the background, and the system's media controls show it – or in one of its own,
  /// which the system manages. Recordings always play in the app's.
  var inAppSession = false

  private(set) var state = "stopped"
  /// Where the voice paused, to go on from there; elsewhere, it starts anew.
  private(set) var pausedAt: WordPosition?
  private let synthesizer = AVSpeechSynthesizer()
  private var speech: Speech?
  private let recording = PlayRecording()
  /// The take of a recording that plays, or that waits for the voice to say what it was given.
  private var take: Take?
  private var takeWaits = false
  /// Whether reading aloud set the app's audio session going, to let it go once it stops.
  private var sessionActive = false
  /// The utterances given to the synthesizer and not yet done, as the core made them, and whether
  /// they sounded yet.
  private var queued: [(spoken: AVSpeechUtterance, utterance: Utterance, sounded: Bool)] = []
  private var started: CFTimeInterval?
  private var unvoiced: Set<String> = []
  /// How long the next utterance may be.
  private var nextLength = firstLength
  /// When the last utterance ended, and in which voice: the next one in it sounds at once.
  private var ended: (time: CFTimeInterval, voice: String)?

  /// The first utterance's length, and the longest, in UTF-16 code units. AVSpeechSynthesizer
  /// names no limit.
  private static let firstLength: UInt32 = 200
  private static let length: UInt32 = 20000
  /// The longest utterance each voice starts at once, by identifier, where that is shorter: a voice
  /// that prepares all of an utterance before it speaks takes the longer to start, the longer it is.
  private static var promptLengths: [String: UInt32] = [:]
  /// An utterance that sounds this late after the one before, in seconds, started late – a voice
  /// that prepares as it speaks takes 0.1 – and the voice's next take as long as it starts in that.
  private static let late = 0.3

  override init() {
    super.init()
    synthesizer.delegate = self
    // An audio session of its own, which the system manages: the app's stays as the app set it.
    synthesizer.usesApplicationAudioSession = false
    recording.onWord = { [weak self] take, word in
      self?.onWord?(WordPlace(passage: take.passage, book: take.book, chapter: word.chapter, verse: word.verse, index: word.index))
    }
    recording.onSound = { [weak self] time in self?.sounded(at: time) }
    recording.onEnd = { [weak self] in self?.takeEnded() }
    recording.onPause = { [weak self] in
      guard let self, state == "speaking" else { return }
      pausedAt = nil
      change("paused")
    }
    recording.onError = { [weak self] in self?.stop() }
  }

  /// Reads the passages from the word at `from`, or from their start, playing chapters from
  /// recordings of the `recorded` voices – with none named, of any. A voice or a recording paused at
  /// that word goes on.
  func play(_ references: [Reference], companions: [String], along: Bool, from: WordPosition?, recorded: [String]?) {
    if state == "paused", from == pausedAt, take != nil, !takeWaits {
      started = CACurrentMediaTime()
      recording.rate = rate
      recording.resume()
      return change("speaking")
    }
    if state == "paused", synthesizer.isPaused, from == pausedAt {
      synthesizer.continueSpeaking()
      return change("speaking")
    }
    silence()
    synthesizer.usesApplicationAudioSession = inAppSession
    if inAppSession {
      activateSession()
    }
    speech = Speech(references: references, companions: companions, along: along, from: from, recorded: recorded)
    started = CACurrentMediaTime()
    change("speaking")
    enqueue()
    enqueue()
    if queued.isEmpty, take == nil {
      stop()
    }
  }

  /// Pauses at the end of the word, `at` which the reader is – a recording at once.
  func pause(at word: WordPosition?) {
    guard state == "speaking" else { return }
    pausedAt = word
    if take != nil, !takeWaits {
      recording.pause()
      return change("paused")
    }
    // The pause isn't the voice's wait.
    ended = nil
    synthesizer.pauseSpeaking(at: .word)
    change("paused")
  }

  /// A new rate: a recording takes it at once; a voice only with what it is given next, so it is
  /// false for one.
  func setRate(_ rate: Double) -> Bool {
    self.rate = rate
    guard take != nil, !takeWaits else { return false }
    recording.setRate(rate)
    return true
  }

  /// Stops; the languages skipped for want of a voice go with the news.
  func stop() {
    let wasStopped = state == "stopped" && speech == nil
    let skipped = unvoiced
    silence()
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    if !wasStopped {
      change("stopped", skipped.isEmpty ? [:] : ["unvoiced": skipped.sorted()])
    }
  }

  /// The system's voices, as a list shows them.
  static func voiceList() -> [[String: Any]] {
    AVSpeechSynthesisVoice.speechVoices().map { voice in
      let quality = switch voice.quality {
      case .premium: "premium"
      case .enhanced: "enhanced"
      default: "default"
      }
      return ["id": voice.identifier, "name": voice.name, "language": voice.language, "quality": quality]
    }
  }

  /// Drops what was to be said, without a word to JS.
  private func silence() {
    speech = nil
    recording.stop()
    take = nil
    takeWaits = false
    queued = []
    pausedAt = nil
    started = nil
    unvoiced = []
    nextLength = Self.firstLength
    ended = nil
    synthesizer.stopSpeaking(at: .immediate)
    state = "stopped"
  }

  /// Tells what changed; while it reads, with whose recording plays.
  private func change(_ state: String, _ details: [String: Any] = [:]) {
    self.state = state
    var change = details.merging(["state": state]) { _, new in new }
    if state == "speaking", change["recording"] == nil {
      change["recording"] = takeWaits ? "" : take?.voice ?? ""
    }
    onChange?(change)
  }

  /// Gives the synthesizer the next utterance with a voice – or the next take to play, once the
  /// voice has said what it was given.
  private func enqueue() {
    guard take == nil else { return }
    while let part = speech?.next(limit: nextLength) {
      let utterance: Utterance
      switch part {
      case .play(let take):
        self.take = take
        takeWaits = !queued.isEmpty
        if takeWaits {
          recording.prepare(take)
        } else {
          playTake()
        }
        return
      case .speak(let spoken):
        utterance = spoken
      }
      guard let voice = voice(for: utterance.language) else {
        if unvoiced.insert(utterance.language).inserted {
          change(state, ["unvoiced": Array(unvoiced).sorted()])
        }
        continue
      }
      let spoken = AVSpeechUtterance(string: utterance.text)
      spoken.voice = voice
      spoken.rate = Self.synthesizerRate(rate)
      queued.append((spoken, utterance, false))
      synthesizer.speak(spoken)
      nextLength = min(nextLength * 2, Self.promptLengths[voice.identifier] ?? Self.length)
      return
    }
  }

  /// AVSpeechSynthesizer's rate for a multiple of its voices' speed. Its scale is no multiple: on a
  /// Mac (2026-10-29), 0.5, its default, read at the voice's speed, 0.68 twice as fast, 1 four times,
  /// and 0, its slowest, at 0.56 times.
  private static func synthesizerRate(_ rate: Double) -> Float {
    let rate = min(max(rate, 0.5), 2)
    let value = rate >= 1 ? 0.5 + (rate - 1) * 0.18 : 0.5 - (1 - rate) * 1.14
    return Float(max(value, Double(AVSpeechUtteranceMinimumSpeechRate)))
  }

  /// The voice chosen for a language, or the system's for it, or the best it has.
  private func voice(for language: String) -> AVSpeechSynthesisVoice? {
    if let id = voices[language], let voice = AVSpeechSynthesisVoice(identifier: id) {
      return voice
    }
    let primary = { (tag: String) in tag.split(separator: "-").first.map(String.init)?.lowercased() ?? tag }
    let candidates = AVSpeechSynthesisVoice.speechVoices().filter { primary($0.language) == primary(language) && !Self.isNovelty($0) }
    if let own = AVSpeechSynthesisVoice(language: language), candidates.contains(own) {
      return own
    }
    return candidates.max { $0.quality.rawValue < $1.quality.rawValue }
  }

  private static func isNovelty(_ voice: AVSpeechSynthesisVoice) -> Bool {
    guard #available(iOS 17, *) else { return false }
    return voice.voiceTraits.contains(.isNoveltyVoice)
  }

  // The synthesizer may call its delegate on another thread; the reader is the main thread's.
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString range: NSRange, utterance spoken: AVSpeechUtterance) {
    onMain { self.willSpeak(range, of: spoken) }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish spoken: AVSpeechUtterance) {
    onMain { self.finished(spoken) }
  }

  private func willSpeak(_ range: NSRange, of spoken: AVSpeechUtterance) {
    guard let index = queued.firstIndex(where: { $0.spoken === spoken }) else { return }
    let utterance = queued[index].utterance
    let now = CACurrentMediaTime()
    sounded(at: now)
    if !queued[index].sounded {
      queued[index].sounded = true
      if let voice = spoken.voice?.identifier, let ended, ended.voice == voice, now - ended.time > Self.late {
        // The voice prepared the utterance before it spoke: the next are shorter.
        let length = max(UInt32(Double(utterance.text.utf16.count) * Self.late / (now - ended.time)), Self.firstLength)
        Self.promptLengths[voice] = min(Self.promptLengths[voice] ?? Self.length, length)
        nextLength = min(nextLength, length)
      }
      ended = nil
      if queued.count < 2 {
        enqueue()
      }
    }
    // The word the range starts in, or the first, if it starts before any.
    let word = utterance.words.last { Int($0.start) <= range.location } ?? utterance.words.first
    word.map { onWord?(WordPlace(passage: utterance.passage, book: utterance.book, chapter: $0.chapter, verse: $0.verse, index: $0.index)) }
  }

  /// The voice or a recording sounded, at `time`: reported once after a start.
  private func sounded(at time: CFTimeInterval) {
    guard let started else { return }
    self.started = nil
    change("speaking", ["firstSound": max(time - started, 0) * 1000])
  }

  private func finished(_ spoken: AVSpeechUtterance) {
    guard queued.contains(where: { $0.spoken === spoken }) else { return }
    queued.removeAll { $0.spoken === spoken }
    ended = spoken.voice.map { (CACurrentMediaTime(), $0.identifier) }
    guard queued.isEmpty else { return }
    if take != nil {
      return playTake()
    }
    // For a voice that reports no words, the next is given now.
    enqueue()
    enqueue()
    if queued.isEmpty, take == nil {
      stop()
    }
  }

  private func activateSession() {
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
    try? AVAudioSession.sharedInstance().setActive(true)
    sessionActive = true
  }

  private func playTake() {
    guard let take else { return }
    takeWaits = false
    sessionActive = true
    recording.rate = rate
    recording.play(take)
    change("speaking")
  }

  /// A take played to its end: what follows it is read.
  private func takeEnded() {
    take = nil
    enqueue()
    enqueue()
    if queued.isEmpty, take == nil {
      stop()
    }
  }
}

private func onMain(_ work: @escaping () -> Void) {
  if Thread.isMainThread {
    work()
  } else {
    DispatchQueue.main.async(execute: work)
  }
}
