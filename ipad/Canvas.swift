import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Canvas", sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = CanvasController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class CanvasController: UIViewController, WKNavigationDelegate {
    private var web: WKWebView!
    private var standalone = true
    private var launchError: String?
    private var remoteURL: String?
    override var prefersStatusBarHidden: Bool { true }

    private func argument(_ name: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        if let url = argument("--verification-url") {
            remoteURL = url
        } else if let url = argument("--canvas-url") {
            remoteURL = url
            UserDefaults.standard.set(url, forKey: "serverURL")
        }
        standalone = remoteURL == nil
        if standalone {
            do {
                if argument("--standalone-verify") != nil {
                    configuration.userContentController.addUserScript(WKUserScript(source: "window.canvasStartupErrors=[];window.addEventListener('error',e=>canvasStartupErrors.push(e.message||('Failed resource '+(e.target.src||e.target.href||''))),true);window.addEventListener('unhandledrejection',e=>canvasStartupErrors.push(String(e.reason)));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
                }
                try CanvasCredential.importPending()
                guard let resources = Bundle.main.resourceURL?.appendingPathComponent("CanvasWeb", isDirectory: true),
                      FileManager.default.fileExists(atPath: resources.appendingPathComponent("index.html").path) else {
                    throw NSError(domain: "Canvas", code: 1, userInfo: [NSLocalizedDescriptionKey: "The bundled canvas is missing."])
                }
                configuration.setURLSchemeHandler(CanvasAssets(root: resources), forURLScheme: "canvas")
                let native = try CanvasNative(boardID: argument("--standalone-board") ?? "default")
                configuration.userContentController.addScriptMessageHandler(native, contentWorld: .page, name: "canvasNative")
            } catch { launchError = error.localizedDescription }
        }
        web = WKWebView(frame: .zero, configuration: configuration)
        view = web
        web.navigationDelegate = self
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.984, green: 0.980, blue: 0.969, alpha: 1)
        #if DEBUG
        web.isInspectable = true
        #endif
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let launchError { showError(launchError); return }
        if standalone {
            var components = URLComponents(string: "canvas://app/?ipad=1&standalone=1")!
            if let scenario = argument("--standalone-verify") {
                components.queryItems?.append(URLQueryItem(name: "nativeVerify", value: scenario))
                if let runID = argument("--standalone-verify-run") {
                    components.queryItems?.append(URLQueryItem(name: "nativeVerifyRun", value: runID))
                }
            }
            web.load(URLRequest(url: components.url!))
            if argument("--standalone-verify") == "stability" { scheduleStabilityObservations() }
        } else if let address = remoteURL, var components = URLComponents(string: address),
                  ["http", "https"].contains(components.scheme ?? ""), components.host != nil {
            var items = components.queryItems?.filter { $0.name != "ipad" } ?? []
            items.append(URLQueryItem(name: "ipad", value: "1"))
            components.queryItems = items
            if let url = components.url { web.load(URLRequest(url: url)) }
        } else { showError("The requested canvas URL is invalid.") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if standalone, navigationAction.targetFrame?.isMainFrame != false {
            let url = navigationAction.request.url
            decisionHandler(url?.scheme == "canvas" && url?.host == "app" ? .allow : .cancel)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard standalone, argument("--standalone-verify") != nil else { return }
        webView.evaluateJavaScript("JSON.stringify({state:document.readyState,canvas:!!window.canvas,errors:window.canvasStartupErrors,root:document.getElementById('root')?.textContent})") { value, error in
            print("Canvas startup diagnostic: \(value ?? error?.localizedDescription ?? "unavailable")")
            fflush(stdout)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? "\(Date()) webcontent terminated".write(to: documents.appendingPathComponent("webcontent-termination.txt"), atomically: true, encoding: .utf8)
    }

    private func scheduleStabilityObservations() {
        let requestedID = argument("--standalone-verify-run") ?? ""
        let runID = requestedID.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil
            ? requestedID : UUID().uuidString
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let started = Date()
        for seconds in [8, 95] {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(seconds)) { [weak self] in
                guard let self else { return }
                let prefix = documents.appendingPathComponent("canvas-stability-\(runID)-\(seconds)")
                let script = """
                JSON.stringify({readyState:document.readyState,visibility:document.visibilityState,
                licenseGate:!!document.querySelector('[data-testid="tl-license-expired"]'),
                licenseState:window.canvas?.editor.licenseManager?.state.get(),
                canvasElement:!!document.querySelector('.tl-canvas'),
                controls:document.querySelectorAll('.history button,.tools button').length,
                shapeIds:window.canvas?.editor.getCurrentPageShapes().map(s=>s.id),
                errors:window.canvasStartupErrors??[]})
                """
                self.web.evaluateJavaScript(script) { value, error in
                    var state: [String: Any] = ["runID": runID, "scheduledSeconds": seconds,
                        "elapsedSeconds": Date().timeIntervalSince(started)]
                    if let text = value as? String, let data = text.data(using: .utf8),
                       let observation = try? JSONSerialization.jsonObject(with: data) {
                        state["javascript"] = observation
                    } else { state["error"] = error?.localizedDescription ?? "Missing JavaScript observation" }
                    do {
                        let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
                        try data.write(to: prefix.appendingPathExtension("state.json"), options: .atomic)
                    } catch { print("Canvas stability observation failed: \(error.localizedDescription)") }
                    guard seconds == 95 else { return }
                    let configuration = WKSnapshotConfiguration()
                    configuration.afterScreenUpdates = false
                    self.web.takeSnapshot(with: configuration) { image, error in
                        do {
                            if let error { throw error }
                            try image?.pngData()?.write(to: prefix.appendingPathExtension("webview.png"), options: .atomic)
                        } catch { print("Canvas stability snapshot failed: \(error.localizedDescription)") }
                    }
                }
            }
        }
    }

    private func showError(_ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Canvas could not open", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
