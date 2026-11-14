import SwiftUI

private extension Color {
    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        func make(_ hex: UInt32) -> UIColor {
            UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? make(dark) : make(light) })
    }

    static let paper = adaptive(light: 0xF3EFE6, dark: 0x131210)
    static let surface = adaptive(light: 0xFBF9F3, dark: 0x1C1A17)
    static let ink = adaptive(light: 0x1D1A16, dark: 0xF1EDE4)
    static let muted = adaptive(light: 0x6B655A, dark: 0xA09A8E)
    static let line = adaptive(light: 0xDBD4C6, dark: 0x322E28)
    static let accent = adaptive(light: 0xBF3A1B, dark: 0xFF7043)
    static let onAccent = adaptive(light: 0xFFFFFF, dark: 0x1A0D07)
    static let accentSoft = adaptive(light: 0xF6DFD6, dark: 0x3B2118)
    static let danger = adaptive(light: 0xA3261A, dark: 0xFF8A7A)
    static let success = adaptive(light: 0x2C6E49, dark: 0x74C69D)
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @FocusState private var linkFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("FetchFrame")
                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.ink)

                hero.padding(.top, 36)
                fetchBar.padding(.top, 26)

                if let message = model.errorMessage {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(Color.danger)
                        .padding(.top, 14)
                }

                switch model.phase {
                case .idle:
                    EmptyView()
                case .looking:
                    LoadingCard().padding(.top, 24)
                case .result(let result):
                    ResultCard(result: result).padding(.top, 24)
                }

                Text("Everything runs on this iPhone. Only save videos you have the right to keep.")
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .padding(.top, 32)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.paper.ignoresSafeArea())
        .tint(Color.accent)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Paste a link.\nKeep the video.")
                .font(.system(size: 46, weight: .bold))
                .kerning(-1.6)
                .lineSpacing(-4)
                .foregroundStyle(Color.ink)
            Text("YouTube, Shorts, Instagram Reels, TikTok, X, Facebook and many more. Or tap Share in any app and pick FetchFrame.")
                .font(.callout)
                .foregroundStyle(Color.muted)
        }
    }

    private var isLooking: Bool {
        if case .looking = model.phase { return true }
        return false
    }

    private var fetchBar: some View {
        VStack(spacing: 8) {
            TextField("Paste a video link", text: $model.link)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($linkFocused)
                .onSubmit(model.lookup)
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
                .foregroundStyle(Color.ink)

            HStack(spacing: 8) {
                PasteButton(payloadType: String.self) { strings in
                    guard let text = strings.first else { return }
                    Task { @MainActor in
                        model.link = text
                        linkFocused = false
                        model.lookup()
                    }
                }
                .labelStyle(.titleOnly)
                .buttonBorderShape(.roundedRectangle(radius: 9))
                // A mid-tone keeps the system's white label readable in light and dark.
                .tint(Color(red: 0.42, green: 0.40, blue: 0.35))

                Button {
                    linkFocused = false
                    model.lookup()
                } label: {
                    Text(isLooking ? "Looking…" : "Find video")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(Color.accent.opacity(isLooking ? 0.6 : 1), in: .rect(cornerRadius: 9))
                        .foregroundStyle(Color.onAccent)
                }
                .disabled(isLooking)
            }
        }
        .padding(7)
        .background(Color.surface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(linkFocused ? Color.accent : Color.ink, lineWidth: 1.5))
    }
}

private struct LoadingCard: View {
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            bar(height: 170, width: nil)
            bar(height: 14, width: 90)
            bar(height: 14, width: nil)
            bar(height: 14, width: 180)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surface, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.line))
        .opacity(dim ? 0.5 : 1)
        .animation(.easeInOut(duration: 0.7).repeatForever(), value: dim)
        .onAppear { dim = true }
        .accessibilityLabel("Finding video")
    }

    private func bar(height: CGFloat, width: CGFloat?) -> some View {
        RoundedRectangle(cornerRadius: 6).fill(Color.line).frame(width: width, height: height)
    }
}

private struct ResultCard: View {
    @EnvironmentObject private var model: AppModel
    let result: InspectResult

    private var videoOptions: [MediaOption] {
        model.container == "webm" ? result.video.webm : result.video.mp4
    }

    private var metadata: String {
        [result.uploader, Format.duration(result.duration)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary

            if model.isDownloading {
                Text("Keep FetchFrame open until your download finishes.")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.accent)
                    .padding(.top, 14)
            }

            sectionHeader("Video", showsSwitch: !result.video.mp4.isEmpty && !result.video.webm.isEmpty)
            if videoOptions.isEmpty {
                Text("No video streams at this link. Audio is below.")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .padding(.vertical, 12)
            } else {
                optionList(videoOptions)
            }

            if !result.audio.isEmpty {
                sectionHeader("Audio only", showsSwitch: false)
                optionList(result.audio)
            }
        }
        .padding(16)
        .background(Color.surface, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.line))
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let thumbnail = result.thumbnail, let url = URL(string: thumbnail) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.line
                }
                .frame(maxWidth: .infinity)
                .frame(height: 190)
                .clipShape(.rect(cornerRadius: 10))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(Format.source(result.source))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accent)
                Text(result.title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.ink)
                    .lineLimit(2)
                if !metadata.isEmpty {
                    Text(metadata).font(.subheadline).foregroundStyle(Color.muted)
                }
                if result.firstOfCollection {
                    Text("This link holds several items. Showing the first one.")
                        .font(.footnote).foregroundStyle(Color.muted)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, showsSwitch: Bool) -> some View {
        HStack {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
            Spacer()
            if showsSwitch {
                ContainerSwitch(selection: $model.container)
            }
        }
        .frame(minHeight: 34)
        .padding(.top, 20)
        .padding(.bottom, 6)
    }

    private func optionList(_ options: [MediaOption]) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(Color.line)
            ForEach(options) { option in
                OptionRow(job: model.job(for: option, in: result))
                if option.id != options.last?.id {
                    Divider().overlay(Color.line)
                }
            }
        }
    }
}

private struct ContainerSwitch: View {
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 0) {
            segment("MP4", value: "mp4")
            segment("WebM", value: "webm")
        }
        .padding(2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.line))
    }

    private func segment(_ title: String, value: String) -> some View {
        let isSelected = selection == value
        return Button {
            selection = value
        } label: {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .frame(minHeight: 30)
                .padding(.horizontal, 11)
                .background(isSelected ? Color.ink : Color.clear, in: .rect(cornerRadius: 6))
                .foregroundStyle(isSelected ? Color.paper : Color.muted)
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct OptionRow: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var job: DownloadJob
    @State private var limitReached = false

    private var option: MediaOption { job.option }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 7) {
                        Text(option.label)
                            .font(.system(size: 15, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Color.ink)
                        if let badge = option.badge {
                            Text(badge)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.accentSoft, in: .rect(cornerRadius: 4))
                                .foregroundStyle(Color.accent)
                        }
                    }
                    subtitle
                }
                Spacer(minLength: 8)
                action
            }
            progress
        }
        .padding(.vertical, 10)
    }

    private var subtitle: some View {
        let parts = [option.description, option.size.map { "≈ \(Format.bytes(Double($0)))" }]
            .compactMap { $0 }.filter { !$0.isEmpty }
        return Text(parts.joined(separator: " · "))
            .font(.footnote)
            .foregroundStyle(Color.muted)
    }

    @ViewBuilder
    private var action: some View {
        switch job.state {
        case .idle:
            rowButton("Download", prominent: true) { begin() }
        case .running:
            rowButton("Cancel", prominent: false) { job.cancel() }
        case .failed:
            rowButton("Try again", prominent: true) { begin() }
        case .finished(let file, _):
            ShareLink(item: file) {
                Text("Share")
                    .font(.subheadline.weight(.semibold))
                    .frame(minWidth: 72, minHeight: 38)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.ink))
                    .foregroundStyle(Color.ink)
            }
        }
    }

    private func begin() {
        limitReached = !model.canStartDownload
        if !limitReached {
            job.start()
        }
    }

    private func rowButton(_ title: String, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(minWidth: 72, minHeight: 38)
                .padding(.horizontal, 4)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(prominent ? Color.ink : Color.line))
                .foregroundStyle(prominent ? Color.ink : Color.muted)
        }
        .accessibilityLabel("\(title) \(option.label)")
    }

    @ViewBuilder
    private var progress: some View {
        if limitReached, case .idle = job.state {
            Text("Up to \(AppModel.maxActiveDownloads) downloads can run at once. Wait for one to finish.")
                .font(.footnote).foregroundStyle(Color.danger)
        }
        switch job.state {
        case .idle:
            EmptyView()
        case .running:
            ProgressView(value: job.percent, total: 100)
                .tint(Color.accent)
            HStack {
                Text("\(job.stage) \(Int(job.percent))%")
                Spacer()
                Text(job.speedAndTime)
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Color.muted)
        case .failed(let message):
            Text(message).font(.footnote).foregroundStyle(Color.danger)
        case .finished(_, let savedToPhotos):
            Text(savedToPhotos ? "Saved to Photos and Files" : "Saved in Files › FetchFrame")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Color.success)
        }
    }
}
