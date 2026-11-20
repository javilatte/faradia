// Faradia's dictation with macOS's own speech recognition (the Speech framework), on the device: the
// audio never leaves the Mac. Faradia compiles this file the first time it is needed (appleEngine.js)
// and runs it once per dictation.
//
//   faradia-transcribe <recording.wav> <locale,locale…>
//
// With several locales (es-ES,en-US) it recognizes the recording in each and keeps the one Apple is
// most confident about: the Speech framework does not detect the language by itself. It prints one
// JSON line: {"ok":true,"text":…,"locale":…,"confidence":…} or {"ok":false,"code":…,"message":…},
// where code is denied, restricted, unsupported, unavailable or failed.

import Foundation
import Speech

func emit(_ object: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false,\"code\":\"failed\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(object["ok"] as? Bool == true ? 0 : 1)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "code": code, "message": message])
}

// Asks once: macOS shows its permission dialog the first time (for the app that started Faradia,
// such as Terminal) and remembers the answer.
func authorize() -> SFSpeechRecognizerAuthorizationStatus {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current != .notDetermined { return current }
  let done = DispatchSemaphore(value: 0)
  var status = current
  SFSpeechRecognizer.requestAuthorization { answer in
    status = answer
    done.signal()
  }
  done.wait()
  return status
}

struct Recognition {
  var locale: String
  var text = ""
  var confidence = 0.0
  var error: String?
  var code = "failed"
}

func recognize(_ url: URL, _ locale: String) -> Recognition {
  var out = Recognition(locale: locale)
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    out.code = "unsupported"
    out.error = "macOS no reconoce el idioma \(locale)"
    return out
  }
  guard recognizer.supportsOnDeviceRecognition else {
    out.code = "unsupported"
    out.error = "el idioma \(locale) no se puede reconocer sin conexión en este Mac"
    return out
  }
  guard recognizer.isAvailable else {
    out.code = "unavailable"
    out.error = "el reconocimiento de voz de macOS no está disponible ahora"
    return out
  }
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  request.taskHint = .dictation
  if #available(macOS 13, *) { request.addsPunctuation = true }

  // Results arrive on this serial queue, never on the main thread (which is parked in dispatchMain).
  let queue = OperationQueue()
  queue.maxConcurrentOperationCount = 1
  recognizer.queue = queue
  let done = DispatchSemaphore(value: 0)
  var finished = false
  let task = recognizer.recognitionTask(with: request) { result, error in
    if finished { return }
    if let result = result, result.isFinal {
      out.text = result.bestTranscription.formattedString
      let segments = result.bestTranscription.segments
      out.confidence = segments.isEmpty ? 0 : segments.map { Double($0.confidence) }.reduce(0, +) / Double(segments.count)
      finished = true
      done.signal()
    } else if let error = error as NSError? {
      // "No speech detected" is an empty dictation, not a failure.
      if error.domain == "kAFAssistantErrorDomain" && error.code == 1110 {
        out.text = ""
      } else {
        out.error = error.localizedDescription
      }
      finished = true
      done.signal()
    }
  }
  if done.wait(timeout: .now() + 180) == .timedOut {
    task.cancel()
    out.error = "el reconocimiento de voz de macOS no terminó a tiempo"
  }
  return out
}

func run() -> Never {
  let args = CommandLine.arguments
  guard args.count >= 3 else { fail("failed", "uso: faradia-transcribe <grabación.wav> <idioma,idioma…>") }
  let url = URL(fileURLWithPath: args[1])
  let locales = args[2].split(separator: ",").map(String.init).filter { !$0.isEmpty }
  guard !locales.isEmpty else { fail("failed", "falta el idioma") }

  switch authorize() {
  case .authorized: break
  case .denied: fail("denied", "macOS no da permiso de reconocimiento de voz")
  case .restricted: fail("restricted", "el reconocimiento de voz está restringido en este Mac")
  default: fail("denied", "macOS no ha dado permiso de reconocimiento de voz")
  }

  // Every locale at once: each recognizer works on its own.
  var results = [Recognition](repeating: Recognition(locale: ""), count: locales.count)
  let group = DispatchGroup()
  let lock = NSLock()
  for (i, locale) in locales.enumerated() {
    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      let r = recognize(url, locale)
      lock.lock()
      results[i] = r
      lock.unlock()
      group.leave()
    }
  }
  group.wait()

  let usable = results.filter { $0.error == nil }
  guard let best = usable.max(by: { a, b in
    // An empty transcript only wins when every locale heard nothing.
    if a.text.isEmpty != b.text.isEmpty { return a.text.isEmpty }
    return a.confidence < b.confidence
  }) else {
    let first = results.first!
    fail(first.code, first.error ?? "no se pudo reconocer la grabación")
  }
  emit(["ok": true, "text": best.text, "locale": best.locale, "confidence": best.confidence])
}

DispatchQueue.global(qos: .userInitiated).async { run() }
dispatchMain()
