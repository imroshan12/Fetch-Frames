import Foundation

struct EngineError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }

    static let cancelled = EngineError(code: "cancelled", message: "Download cancelled.")
    var isCancellation: Bool { code == "cancelled" }
}

/// Runs blocking engine work on a thread whose stack is large enough for Python and FFmpeg.
enum LargeStack {
    private static let stackSize = 16 * 1024 * 1024

    static func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let thread = Thread { continuation.resume(with: Result { try work() }) }
            thread.stackSize = stackSize
            thread.start()
        }
    }
}

/// Calls into the embedded yt-dlp. Every function exchanges JSON with fetchframe_bridge.py.
enum PythonEngine {
    private struct Reply<Value: Decodable>: Decodable {
        struct Failure: Decodable {
            let code: String
            let message: String
        }

        let ok: Value?
        let error: Failure?
    }

    struct Nothing: Decodable {}

    private static let startLock = NSLock()
    private static var startResult: Result<Void, EngineError>?

    /// Python can only start once, and importing yt-dlp takes a moment, so it's done on first use.
    private static func ensureStarted() throws {
        startLock.lock()
        defer { startLock.unlock() }
        if startResult == nil {
            startResult = start()
        }
        try startResult!.get()
    }

    private static func start() -> Result<Void, EngineError> {
        if let failure = FFPythonStart() {
            return .failure(EngineError(code: "failed", message: "The download engine couldn't start. \(failure)"))
        }
        let caches = URL.cachesDirectory.appending(path: "yt-dlp").path(percentEncoded: false)
        let reply = FFPythonCall("configure", encode(["cacheDir": caches]))
        do {
            let _: Nothing = try decode(reply)
            return .success(())
        } catch let error as EngineError {
            return .failure(error)
        } catch {
            return .failure(EngineError(code: "failed", message: "The download engine couldn't start."))
        }
    }

    private static func encode(_ arguments: [String: String]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: arguments)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private static func decode<Value: Decodable>(_ text: String) throws -> Value {
        let reply = try JSONDecoder().decode(Reply<Value>.self, from: Data(text.utf8))
        if let failure = reply.error {
            throw EngineError(code: failure.code, message: failure.message)
        }
        guard let value = reply.ok else {
            throw EngineError(code: "failed", message: "Something went wrong. Try again.")
        }
        return value
    }

    static func call<Value: Decodable>(_ function: String, _ arguments: [String: String]) async throws -> Value {
        let payload = encode(arguments)
        return try await LargeStack.run {
            try ensureStarted()
            return try decode(FFPythonCall(function, payload))
        }
    }
}
