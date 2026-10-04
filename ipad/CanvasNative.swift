import Foundation
import Darwin
import Security
import WebKit

private enum CanvasNativeError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

enum CanvasCredential {
    private static let service = "in.texoport.tldrawipad.deepseek"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "api-key"]
    }

    static func importPending() throws {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = documents.appendingPathComponent("deepseek-key-import.txt")
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        defer { try? FileManager.default.removeItem(at: file) }
        let key = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else {
            throw CanvasNativeError.invalid("The imported provider key is invalid.")
        }
        var item = query
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update = [kSecValueData as String: Data(key.utf8)]
            guard SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecSuccess else {
                throw CanvasNativeError.invalid("Could not update the provider key in Keychain.")
            }
        } else if status != errSecSuccess {
            throw CanvasNativeError.invalid("Could not store the provider key in Keychain.")
        }
    }

    static func read() throws -> String {
        var item = query
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let key = String(data: data, encoding: .utf8) else {
            throw CanvasNativeError.invalid("Provision a DeepSeek key on this iPad first.")
        }
        return key
    }
}

final class CanvasAssets: NSObject, WKURLSchemeHandler {
    private let root: URL
    init(root: URL) { self.root = root.standardizedFileURL }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url, url.scheme == "canvas", url.host == "app",
                  !url.pathComponents.contains(".."), !url.path.contains("\\") else {
                throw CanvasNativeError.invalid("Invalid bundled resource.")
            }
            let path = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
            let file = root.appendingPathComponent(path).standardizedFileURL
            let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
            guard file.path.hasPrefix(prefix) else {
                throw CanvasNativeError.invalid("Invalid bundled resource path.")
            }
            let data = try Data(contentsOf: file)
            let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json",
                         "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
                         "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "ico": "image/x-icon"]
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": types[file.pathExtension] ?? "application/octet-stream",
                               "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*"]) else {
                throw CanvasNativeError.invalid("Could not create bundled resource response.")
            }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

final class CanvasNative: NSObject, WKScriptMessageHandlerWithReply, URLSessionTaskDelegate {
    private let root: URL
    private let queue = DispatchQueue(label: "in.texoport.tldrawipad.storage")
    private var tasks: [String: URLSessionDataTask] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 180
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(boardID: String) throws {
        guard !boardID.isEmpty, boardID.count <= 80,
              boardID.range(of: "^[A-Za-z0-9-]+$", options: .regularExpression) != nil else {
            throw CanvasNativeError.invalid("Invalid standalone board identifier.")
        }
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Canvas", isDirectory: true).appendingPathComponent(boardID, isDirectory: true)
            .standardizedFileURL
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                              attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "canvas", message.frameInfo.request.url?.host == "app",
              let request = message.body as? [String: Any], let op = request["op"] as? String else {
            replyHandler(nil, "Native operations require the bundled canvas main frame.")
            return
        }
        queue.async {
            let reply: (Any?, String?) -> Void = { value, error in
                DispatchQueue.main.async { replyHandler(value, error) }
            }
            do {
                if op == "provider.fetch" { try self.fetch(request, reply: reply); return }
                if op == "provider.cancel" {
                    let id = try self.string(request, "id")
                    self.tasks.removeValue(forKey: id)?.cancel()
                    reply(NSNull(), nil)
                    return
                }
                reply(try self.fileOperation(op, request: request), nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }

    private func string(_ request: [String: Any], _ key: String) throws -> String {
        guard let value = request[key] as? String else { throw CanvasNativeError.invalid("Missing string field \(key).") }
        return value
    }

    private func fileURL(_ path: String) throws -> URL {
        guard path.utf8.count <= 1024, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else {
            throw CanvasNativeError.invalid("Storage paths must be bounded relative paths.")
        }
        let components = path.split(separator: "/").map(String.init)
        guard !components.contains("..") else { throw CanvasNativeError.invalid("Storage traversal is not allowed.") }
        let result = components.filter { $0 != "." }.reduce(root) { $0.appendingPathComponent($1) }.standardizedFileURL
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard result == root || result.path.hasPrefix(prefix) else {
            throw CanvasNativeError.invalid("Storage path escapes the board.")
        }
        var cursor = root
        for component in components where component != "." {
            cursor.appendPathComponent(component)
            if let attributes = try? FileManager.default.attributesOfItem(atPath: cursor.path),
               attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                throw CanvasNativeError.invalid("Storage symlinks are not allowed.")
            }
        }
        return result
    }

    private func fileOperation(_ op: String, request: [String: Any]) throws -> Any {
        let file = try fileURL(string(request, "path"))
        let manager = FileManager.default
        switch op {
        case "file.readBytes":
            guard manager.fileExists(atPath: file.path) else { return NSNull() }
            return try Data(contentsOf: file).base64EncodedString()
        case "file.read":
            guard manager.fileExists(atPath: file.path) else { return NSNull() }
            return try String(contentsOf: file, encoding: .utf8)
        case "file.mkdir":
            try manager.createDirectory(at: file, withIntermediateDirectories: true)
        case "file.list":
            return try manager.contentsOfDirectory(atPath: file.path).sorted()
        case "file.write":
            guard file != root else { throw CanvasNativeError.invalid("Cannot replace the board directory.") }
            try Data(string(request, "text").utf8).write(to: file, options: .atomic)
        case "file.append":
            if !manager.fileExists(atPath: file.path) { try Data().write(to: file) }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(string(request, "text").utf8))
        case "file.flush":
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.synchronize()
        case "file.truncate":
            guard let number = request["size"] as? NSNumber, number.doubleValue >= 0,
                  number.doubleValue <= Double(Int.max), number.doubleValue.rounded() == number.doubleValue else {
                throw CanvasNativeError.invalid("File size must be a nonnegative integer.")
            }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.truncate(atOffset: number.uint64Value)
        case "file.rename":
            let target = try fileURL(string(request, "to"))
            guard file != root, target != root else { throw CanvasNativeError.invalid("Cannot rename the board directory.") }
            guard Darwin.rename(file.path, target.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        case "file.remove":
            guard file != root else { throw CanvasNativeError.invalid("Cannot remove the board directory.") }
            if manager.fileExists(atPath: file.path) { try manager.removeItem(at: file) }
        default: throw CanvasNativeError.invalid("Unknown native operation.")
        }
        return NSNull()
    }

    private func fetch(_ request: [String: Any], reply: @escaping (Any?, String?) -> Void) throws {
        let id = try string(request, "id")
        guard id.count <= 128, tasks[id] == nil,
              let url = URL(string: try string(request, "url")), url.scheme == "https",
              url.host == "api.deepseek.com", url.path == "/chat/completions",
              url.port == nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw CanvasNativeError.invalid("Provider requests must target the DeepSeek chat endpoint.")
        }
        var nativeRequest = URLRequest(url: url)
        nativeRequest.httpMethod = "POST"
        nativeRequest.httpBody = Data(try string(request, "body").utf8)
        if let headers = request["headers"] as? [String: String] {
            for (name, value) in headers where ["content-type", "accept"].contains(name.lowercased()) {
                nativeRequest.setValue(value, forHTTPHeaderField: name)
            }
        }
        nativeRequest.setValue("Bearer \(try CanvasCredential.read())", forHTTPHeaderField: "Authorization")
        nativeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let task = session.dataTask(with: nativeRequest) { data, response, error in
            self.queue.async {
                self.tasks.removeValue(forKey: id)
                if let error { reply(nil, error.localizedDescription); return }
                guard let response = response as? HTTPURLResponse,
                      let data, let body = String(data: data, encoding: .utf8) else {
                    reply(nil, "Provider returned an invalid UTF-8 response."); return
                }
                if (300..<400).contains(response.statusCode) {
                    reply(nil, "Provider redirects are not allowed."); return
                }
                var headers: [String: String] = [:]
                for (key, value) in response.allHeaderFields { headers[String(describing: key)] = String(describing: value) }
                reply(["status": response.statusCode, "headers": headers, "body": body], nil)
            }
        }
        tasks[id] = task
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
