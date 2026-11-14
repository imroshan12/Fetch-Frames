import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum Phase {
        case idle
        case looking
        case result(InspectResult)
    }

    static let maxActiveDownloads = 3

    @Published var link = ""
    @Published var container = "mp4"
    @Published private(set) var phase = Phase.idle
    @Published private(set) var errorMessage: String?
    @Published private(set) var isDownloading = false

    private var jobs: [String: DownloadJob] = [:]
    private var lookupToken = 0

    func lookup() {
        let url = Format.extractLink(link)
        guard !url.isEmpty else { return }
        guard let scheme = URL(string: url)?.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            link = url
            errorMessage = "Paste a full video link starting with http or https."
            phase = .idle
            return
        }
        link = url
        lookupToken += 1
        let token = lookupToken
        errorMessage = nil
        phase = .looking
        Task {
            do {
                let result: InspectResult = try await PythonEngine.call("inspect", ["url": url])
                guard token == lookupToken else { return }
                container = result.video.mp4.isEmpty ? "webm" : "mp4"
                phase = .result(result)
            } catch {
                guard token == lookupToken else { return }
                errorMessage = error.localizedDescription
                phase = .idle
            }
        }
    }

    /// Handles fetchframe://fetch?url=… from the share sheet.
    func handleIncoming(_ url: URL) {
        guard url.scheme == "fetchframe",
              let shared = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "url" })?.value else {
            return
        }
        link = shared
        lookup()
    }

    func job(for option: MediaOption, in result: InspectResult) -> DownloadJob {
        let key = "\(result.id):\(option.id)"
        if let existing = jobs[key] {
            return existing
        }
        let job = DownloadJob(option: option, inspectId: result.id, title: result.title) { [weak self] in
            self?.refreshActivity()
        }
        jobs[key] = job
        return job
    }

    var canStartDownload: Bool {
        jobs.values.filter(\.isRunning).count < Self.maxActiveDownloads
    }

    private func refreshActivity() {
        isDownloading = jobs.values.contains(where: \.isRunning)
        // iOS suspends apps when the screen locks, which would interrupt a download.
        UIApplication.shared.isIdleTimerDisabled = isDownloading
    }
}
