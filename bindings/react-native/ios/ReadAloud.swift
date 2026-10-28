import AVFoundation

/// Reads passages aloud with the device's voices, a voice for each language: utterances from the
/// core, one after the other, so their text never passes through JS. The first is short, so the
/// voice starts at once; the rest are long, so few sentences are cut apart. It tells the reader the
/// word the voice comes to, as the voice reports it.
final class ReadAloud: NSObject, AVSpeechSynthesizerDelegate {
  /// The voice comes to a word of an utterance.
  var onWord: ((Utterance, Word) -> Void)?
  /// "speaking", "paused" or "stopped"; after a start, how long until the first word sounded, in
  /// milliseconds; the languages skipped for want of a voice.
  var onChange: (([String: Any]) -> Void)?
  /// A voice per language, by identifier; otherwise the device's for it.
  var voices: [String: String] = [:]

  private(set) var state = "stopped"
  /// Where the voice paused, to go on from there; elsewhere, it starts anew.
  private(set) var pausedAt: WordPosition?
  private let synthesizer = AVSpeechSynthesizer()
  private var speech: Speech?
  /// The utterances given to the synthesizer and not yet done, as the core made them.
  private var queued: [(spoken: AVSpeechUtterance, utterance: Utterance)] = []
  private var started: CFTimeInterval?
  private var unvoiced: Set<String> = []

  /// The first utterance's length, and the others', in UTF-16 code units. AVSpeechSynthesizer
  /// names no limit.
  private static let firstLength: UInt32 = 200
  private static let length: UInt32 = 20000

  override init() {
    super.init()
    synthesizer.delegate = self
    // An audio session of its own, which the system manages: the app's stays as the app set it.
    synthesizer.usesApplicationAudioSession = false
  }

  /// Reads the passages from the word at `from`, or from their start; a voice paused there goes on.
  func play(_ references: [Reference], companions: [String], along: Bool, from: WordPosition?) {
    if state == "paused", synthesizer.isPaused, from == pausedAt {
      synthesizer.continueSpeaking()
      return change("speaking")
    }
    silence()
    speech = Speech(references: references, companions: companions, along: along, from: from)
    started = CACurrentMediaTime()
    change("speaking")
    enqueue(Self.firstLength)
    enqueue(Self.length)
    if queued.isEmpty {
      stop()
    }
  }

  /// Pauses at the end of the word, `at` which the reader is.
  func pause(at word: WordPosition?) {
    guard state == "speaking" else { return }
    pausedAt = word
    synthesizer.pauseSpeaking(at: .word)
    change("paused")
  }

  /// Stops; the languages skipped for want of a voice go with the news.
  func stop() {
    let wasStopped = state == "stopped" && speech == nil
    let skipped = unvoiced
    silence()
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
    queued = []
    pausedAt = nil
    started = nil
    unvoiced = []
    synthesizer.stopSpeaking(at: .immediate)
    state = "stopped"
  }

  private func change(_ state: String, _ details: [String: Any] = [:]) {
    self.state = state
    onChange?(details.merging(["state": state]) { _, new in new })
  }

  /// Gives the synthesizer the next utterance with a voice, at most `length` long.
  private func enqueue(_ length: UInt32) {
    while let utterance = speech?.next(limit: length) {
      guard let voice = voice(for: utterance.language) else {
        if unvoiced.insert(utterance.language).inserted {
          change(state, ["unvoiced": Array(unvoiced).sorted()])
        }
        continue
      }
      let spoken = AVSpeechUtterance(string: utterance.text)
      spoken.voice = voice
      queued.append((spoken, utterance))
      synthesizer.speak(spoken)
      return
    }
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
    guard let utterance = queued.first(where: { $0.spoken === spoken })?.utterance else { return }
    if let started {
      self.started = nil
      change("speaking", ["firstSound": (CACurrentMediaTime() - started) * 1000])
    }
    // The word the range starts in, or the first, if it starts before any.
    let word = utterance.words.last { Int($0.start) <= range.location } ?? utterance.words.first
    word.map { onWord?(utterance, $0) }
  }

  private func finished(_ spoken: AVSpeechUtterance) {
    guard queued.contains(where: { $0.spoken === spoken }) else { return }
    queued.removeAll { $0.spoken === spoken }
    enqueue(Self.length)
    if queued.isEmpty {
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
