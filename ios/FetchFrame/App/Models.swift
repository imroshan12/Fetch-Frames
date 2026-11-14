import Foundation

struct InspectResult: Decodable, Identifiable {
    struct VideoLists: Decodable {
        let mp4: [MediaOption]
        let webm: [MediaOption]
    }

    let id: String
    let title: String
    let uploader: String?
    let duration: Double?
    let thumbnail: String?
    let source: String?
    let firstOfCollection: Bool
    let video: VideoLists
    let audio: [MediaOption]
}

struct MediaOption: Decodable, Identifiable {
    struct Plan: Decodable {
        enum CodingKeys: String, CodingKey {
            case videoFormat, audioFormat, mode, videoShare
            case fileExtension = "extension"
        }

        let videoFormat: String
        let audioFormat: String?
        let mode: String
        let fileExtension: String
        let videoShare: Double?
    }

    let id: String
    let kind: String
    let container: String
    let label: String
    let badge: String?
    let dimensions: String?
    let fps: Int?
    let detail: String?
    let limitedPlayback: Bool
    let size: Int64?
    let plan: Plan

    var description: String {
        if let detail {
            return detail
        }
        var parts: [String] = []
        if let dimensions { parts.append(dimensions) }
        if let fps { parts.append("\(fps) fps") }
        if limitedPlayback { parts.append("HDR, best in VLC") }
        return parts.joined(separator: " · ")
    }
}

enum Format {
    static func bytes(_ value: Double) -> String {
        guard value > 0 else { return "" }
        let units = ["B", "KB", "MB", "GB"]
        var amount = value
        var unit = 0
        while amount >= 1000, unit < units.count - 1 {
            amount /= 1000
            unit += 1
        }
        let number = amount >= 100 || unit == 0 ? String(Int(amount.rounded())) : String(format: "%.1f", amount)
        return "\(number) \(units[unit])"
    }

    static func duration(_ seconds: Double?) -> String {
        guard let seconds, seconds > 0 else { return "" }
        let total = Int(seconds.rounded())
        let (hours, minutes, remainder) = (total / 3600, (total % 3600) / 60, total % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
            : String(format: "%d:%02d", minutes, remainder)
    }

    /// yt-dlp's internal site names, where they differ from the brand.
    static func source(_ name: String?) -> String {
        switch name {
        case "Youtube", "YoutubeTab": "YouTube"
        case "Twitter": "X"
        case let name?: name
        case nil: "Video"
        }
    }

    /// Accepts share text like "Watch this https://…" and links with no scheme.
    static func extractLink(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = trimmed.range(of: #"https?://\S+"#, options: [.regularExpression, .caseInsensitive]) {
            return String(trimmed[range])
        }
        if trimmed.range(of: #"^[\w-]+(\.[\w-]+)+/\S*$"#, options: .regularExpression) != nil {
            return "https://\(trimmed)"
        }
        return trimmed
    }
}
