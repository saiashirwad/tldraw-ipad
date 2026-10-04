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
    private let web = WKWebView()
    private var serverURL: String {
        UserDefaults.standard.string(forKey: "serverURL") ?? "http://home.local:4789"
    }
    override var prefersStatusBarHidden: Bool { true }

    override func loadView() {
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
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--canvas-url"), arguments.indices.contains(index + 1) {
            UserDefaults.standard.set(arguments[index + 1], forKey: "serverURL")
        }
        connect()
    }

    private func connect() {
        guard var components = URLComponents(string: serverURL),
              ["http", "https"].contains(components.scheme ?? ""), components.host != nil else {
            showConnectionError()
            return
        }
        components.queryItems = [URLQueryItem(name: "ipad", value: "1")]
        guard let url = components.url else { return }
        web.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showConnectionError()
    }

    private func showConnectionError() {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Open your Mac canvas", message: "Run pnpm dev on your Mac and use its iPad URL. Keep both devices on the same network.", preferredStyle: .alert)
        alert.addTextField { field in
            field.text = self.serverURL
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "Connect", style: .default) { _ in
            let address = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            UserDefaults.standard.set(address, forKey: "serverURL")
            self.connect()
        })
        present(alert, animated: true)
    }
}
