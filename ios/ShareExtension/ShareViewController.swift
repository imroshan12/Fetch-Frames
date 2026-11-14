import UIKit
import UniformTypeIdentifiers

/// Receives a link from any app's share sheet and opens FetchFrame with it.
final class ShareViewController: UIViewController {
    private let messageLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        messageLabel.text = "Opening FetchFrame…"
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0
        messageLabel.font = .preferredFont(forTextStyle: .headline)
        messageLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(messageLabel)
        NSLayoutConstraint.activate([
            messageLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            messageLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            messageLabel.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await forwardSharedLink() }
    }

    private func forwardSharedLink() async {
        guard let link = await sharedLink(), let destination = appLink(for: link) else {
            messageLabel.text = "No video link was found in what you shared."
            try? await Task.sleep(for: .seconds(1.5))
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            return
        }
        openContainingApp(destination)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func appLink(for link: String) -> URL? {
        var components = URLComponents()
        components.scheme = "fetchframe"
        components.host = "fetch"
        components.queryItems = [URLQueryItem(name: "url", value: link)]
        return components.url
    }

    /// Apps share links either as URLs or as text with a link somewhere inside it.
    private func sharedLink() async -> String? {
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
               ["http", "https"].contains(url.scheme?.lowercased()) {
                return url.absoluteString
            }
        }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
               let link = firstLink(in: text) {
                return link
            }
        }

        // Some apps put the text in the item itself rather than an attachment.
        for item in items {
            if let text = item.attributedContentText?.string, let link = firstLink(in: text) {
                return link
            }
        }
        return nil
    }

    private func firstLink(in text: String) -> String? {
        guard let range = text.range(of: #"https?://\S+"#, options: [.regularExpression, .caseInsensitive]) else {
            return nil
        }
        return String(text[range])
    }

    /// Share extensions have no public way to open their app. Walking the responder
    /// chain to UIApplication does the job, which is fine for a self-installed app
    /// but is one reason this couldn't go on the App Store.
    private func openContainingApp(_ url: URL) {
        typealias OpenFunction = @convention(c) (AnyObject, Selector, URL, NSDictionary, AnyObject?) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                let open = unsafeBitCast(current.method(for: selector), to: OpenFunction.self)
                open(current, selector, url, [:], nil)
                return
            }
            responder = current.next
        }
    }
}
