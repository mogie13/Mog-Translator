import UIKit
import WebKit
import UniformTypeIdentifiers

/// Mog Translator for iOS: hosts the web app (copied from the repo root into the
/// bundle's "www" folder at build time) in a WKWebView. Everything works offline.
///
/// The page is served from a custom `mog://app/` scheme rather than file:// because
/// app.js is an ES module and localStorage/IndexedDB need a stable origin.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let scheme = "mog"
    private var web: WKWebView!
    private var downloads: [ObjectIdentifier: URL] = [:]

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: Self.scheme)

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true      // swipe back between tabs/entries
        web.backgroundColor = UIColor(red: 107 / 255, green: 22 / 255, blue: 38 / 255, alpha: 1)
        web.isOpaque = false
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }  // Safari > Develop for debugging
        #endif
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        web.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // "Export" is a blob: link with a download name: save it, then offer the share sheet
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.allow) }
        if [Self.scheme, "blob", "data", "about"].contains(scheme) { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        UIApplication.shared.open(url)                       // source links open in Safari
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: microphone for "Record" in Contribute (iOS still shows its own permission prompt)

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == Self.scheme && type == .microphone ? .grant : .deny)
    }

    // MARK: JS dialogs

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    // MARK: WKDownloadDelegate: write to a temp file, then share (Save to Files, WhatsApp, Mail...)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = suggestedFilename.isEmpty ? "mog-contributions.json" : suggestedFilename.replacingOccurrences(of: "/", with: "-")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        if let pop = share.popoverPresentationController {    // iPad needs an anchor
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let a = UIAlertController(title: "Couldn't export", message: error.localizedDescription, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a, animated: true)
    }
}

/// Serves files from the app bundle's "www" folder at mog://app/<path>.
/// sw.js isn't bundled: the app is already offline, so the page's service worker
/// registration fails quietly (it already catches that).
private final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true).standardizedFileURL

    private static let mime: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "json": "application/json",
        "webmanifest": "application/manifest+json", "svg": "image/svg+xml", "png": "image/png",
        "woff2": "font/woff2", "css": "text/css", "txt": "text/plain",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL

        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let ext = file.pathExtension.lowercased()
        let mime = Self.mime[ext] ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        let headers = ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
