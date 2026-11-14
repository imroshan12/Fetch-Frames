import Foundation
import Photos
import UIKit

/// Downloads one choice: fetches its streams, merges or converts them, and saves the result.
@MainActor
final class DownloadJob: ObservableObject {
    enum State {
        case idle
        case running
        case finished(file: URL, savedToPhotos: Bool)
        case failed(String)
    }

    private struct PathReply: Decodable { let path: String }
    private struct StatusReply: Decodable {
        let fraction: Double
        let speed: Double?
        let eta: Double?
    }

    /// Carries FFmpeg's C progress callback back to this job.
    private final class ProgressRelay {
        let report: (Double) -> Void
        init(report: @escaping (Double) -> Void) { self.report = report }
    }

    @Published private(set) var state = State.idle
    @Published private(set) var percent = 0.0
    @Published private(set) var stage = "Starting…"
    @Published private(set) var speedAndTime = ""

    let option: MediaOption
    private let inspectId: String
    private let title: String
    private let onActivityChange: () -> Void
    private let jobId = UUID().uuidString
    private let cancelFlag: UnsafeMutablePointer<Int32>
    private var cancelRequested = false
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    init(option: MediaOption, inspectId: String, title: String, onActivityChange: @escaping () -> Void) {
        self.option = option
        self.inspectId = inspectId
        self.title = title
        self.onActivityChange = onActivityChange
        cancelFlag = .allocate(capacity: 1)
        cancelFlag.initialize(to: 0)
    }

    deinit {
        cancelFlag.deallocate()
    }

    func start() {
        guard !isRunning else { return }
        cancelRequested = false
        cancelFlag.pointee = 0
        percent = 0
        stage = "Starting…"
        speedAndTime = ""
        state = .running
        onActivityChange()
        backgroundTask = UIApplication.shared.beginBackgroundTask { [weak self] in self?.endBackgroundTask() }
        Task { await run() }
    }

    func cancel() {
        cancelRequested = true
        cancelFlag.pointee = 1
        let jobId = jobId
        Task {
            let _: PythonEngine.Nothing? = try? await PythonEngine.call("cancel", ["jobId": jobId])
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func run() async {
        let workDirectory = URL.temporaryDirectory.appending(path: "jobs/\(jobId)")
        do {
            try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
            let file = try await produceFile(in: workDirectory)
            let savedToPhotos = await Library.saveToPhotos(file)
            percent = 100
            speedAndTime = ""
            state = .finished(file: file, savedToPhotos: savedToPhotos)
        } catch let error as EngineError where error.isCancellation {
            state = .idle
        } catch {
            state = cancelRequested ? .idle : .failed(error.localizedDescription)
        }
        try? FileManager.default.removeItem(at: workDirectory)
        let jobId = jobId
        let _: PythonEngine.Nothing? = try? await PythonEngine.call("finish", ["jobId": jobId])
        endBackgroundTask()
        onActivityChange()
    }

    /// Where the download part of the bar ends. Processing that re-encodes gets the rest.
    private var downloadCeiling: Double {
        switch option.plan.mode {
        case "h264": 40
        case "mp3": 70
        default: 97
        }
    }

    private func produceFile(in directory: URL) async throws -> URL {
        let plan = option.plan
        let ceiling = downloadCeiling
        let videoCeiling = plan.audioFormat == nil ? ceiling : ceiling * (plan.videoShare ?? 0.82)

        let primary = try await downloadStream(
            format: plan.videoFormat, role: "video", directory: directory, from: 0, to: videoCeiling,
            label: option.kind == "audio" ? "Downloading audio" : "Downloading video")
        var audio: String?
        if let audioFormat = plan.audioFormat {
            audio = try await downloadStream(
                format: audioFormat, role: "audio", directory: directory, from: videoCeiling, to: ceiling,
                label: "Downloading audio")
        }

        let output = directory.appending(path: "output.\(plan.fileExtension)")
        stage = switch plan.mode {
        case "h264": "Converting to MP4"
        case "mp3": "Converting audio"
        default: "Finishing file…"
        }
        speedAndTime = ""
        percent = max(percent, ceiling)
        try await process(primary: primary, audio: audio, output: output, from: ceiling)
        return try Library.keep(output, title: title, label: option.label, fileExtension: plan.fileExtension)
    }

    private func downloadStream(format: String, role: String, directory: URL,
                                from lower: Double, to upper: Double, label: String) async throws -> String {
        stage = label
        let jobId = jobId
        let poller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(350))
                guard let status: StatusReply = try? await PythonEngine.call("status", ["jobId": jobId]) else { continue }
                self?.apply(status, from: lower, to: upper, label: label)
            }
        }
        defer { poller.cancel() }

        let reply: PathReply = try await PythonEngine.call("download", [
            "jobId": jobId,
            "inspectId": inspectId,
            "formatId": format,
            "role": role,
            "directory": directory.path(percentEncoded: false),
        ])
        return reply.path
    }

    private func apply(_ status: StatusReply, from lower: Double, to upper: Double, label: String) {
        guard isRunning, stage == label else { return }
        percent = max(percent, lower + status.fraction * (upper - lower))
        var parts: [String] = []
        if let speed = status.speed { parts.append("\(Format.bytes(speed))/s") }
        if let eta = status.eta, eta > 0 { parts.append(Format.duration(eta)) }
        speedAndTime = parts.joined(separator: " · ")
    }

    private func process(primary: String, audio: String?, output: URL, from lower: Double) async throws {
        let mode: FFEngineMode = switch option.plan.mode {
        case "h264": FFEngineModeH264
        case "mp3": FFEngineModeMP3
        case "m4a": FFEngineModeM4A
        default: FFEngineModeCopy
        }
        let relay = ProgressRelay { [weak self] fraction in
            Task { @MainActor in
                guard let self else { return }
                self.percent = max(self.percent, lower + fraction * (99 - lower))
            }
        }
        let context = Unmanaged.passRetained(relay)
        defer { context.release() }

        let cancelFlag = UnsafePointer(self.cancelFlag)
        let outputPath = output.path(percentEncoded: false)
        let opaqueContext = context.toOpaque()
        try await LargeStack.run {
            var message = [CChar](repeating: 0, count: 512)
            let result = FFEngineProcess(primary, audio, outputPath, mode, cancelFlag, { fraction, context in
                Unmanaged<ProgressRelay>.fromOpaque(context!).takeUnretainedValue().report(fraction)
            }, opaqueContext, &message, message.count)
            if result == FFEngineResultCancelled {
                throw EngineError.cancelled
            }
            if result != FFEngineResultSuccess {
                print("FFEngine failed: \(String(cString: message))")
                throw EngineError(code: "failed", message: String(cString: message))
            }
        }
    }
}

/// Where finished files live: the app's Documents folder, which appears in the Files app.
enum Library {
    private static func safeName(_ title: String, label: String) -> String {
        let cleaned = title
            .replacingOccurrences(of: #"[\p{Cc}\\/:*?"<>|#%]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        let shortened = String(cleaned.prefix(120)).replacingOccurrences(of: #"[. ]+$"#, with: "", options: .regularExpression)
        return "\(shortened.isEmpty ? "video" : shortened) [\(label)]"
    }

    static func keep(_ file: URL, title: String, label: String, fileExtension: String) throws -> URL {
        let name = safeName(title, label: label)
        var destination = URL.documentsDirectory.appending(path: "\(name).\(fileExtension)")
        var attempt = 2
        while FileManager.default.fileExists(atPath: destination.path(percentEncoded: false)) {
            destination = URL.documentsDirectory.appending(path: "\(name) (\(attempt)).\(fileExtension)")
            attempt += 1
        }
        try FileManager.default.moveItem(at: file, to: destination)
        return destination
    }

    /// Adds videos Photos can play. Audio, WebM and refused permissions stay in Files only.
    static func saveToPhotos(_ file: URL) async -> Bool {
        guard file.pathExtension == "mp4",
              UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(file.path(percentEncoded: false)) else {
            return false
        }
        let authorization = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard authorization == .authorized || authorization == .limited else {
            return false
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: file)
            }
            return true
        } catch {
            return false
        }
    }
}
