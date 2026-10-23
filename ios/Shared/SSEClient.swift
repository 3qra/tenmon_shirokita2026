import Foundation

/// GET /api/v1/events?topics=... を購読する簡易 EventSource。
///
/// サーバーは「どのトピックが変わったか」だけを送る（event: change, data: orders:<部門ID> など）。
/// 受信したら画面側で最新状態を API から取り直す。通知を受けたこと自体を業務成功とみなさない（仕様 16）。
/// 切断時は指数バックオフで自動再接続し、再接続時の "hello" でも全件を再取得して整合させる。
@MainActor
final class SSEClient {
    /// 引数はトピック名（"orders:<id>" / "screenings" / "resync"）または "hello"
    typealias Handler = @MainActor @Sendable (String) -> Void

    private let url: URL?
    private let handler: Handler
    private var task: Task<Void, Never>?

    nonisolated private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        // サーバーは15秒ごとに ping を送る。45秒以上何も届かなければ切断とみなして再接続する。
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 60 * 60 * 24
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    init(topics: [String], handler: @escaping Handler) {
        let query = [URLQueryItem(name: "topics", value: topics.joined(separator: ","))]
        self.url = try? APIClient.shared.url(path: "/events", query: query)
        self.handler = handler
    }

    var isRunning: Bool { task != nil }

    func start() {
        guard task == nil, let url else { return }
        let handler = self.handler
        task = Task.detached(priority: .utility) {
            await SSEClient.run(url: url, handler: handler)
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    // MARK: - 接続ループ

    nonisolated private static func run(url: URL, handler: @escaping Handler) async {
        var delay: Double = 1
        while !Task.isCancelled {
            let receivedAnything = await connectOnce(url: url, handler: handler)
            if Task.isCancelled { return }
            if receivedAnything { delay = 1 }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    /// 1回接続して、切断されるまでイベントを処理する。何か受信できたら true。
    nonisolated private static func connectOnce(url: URL, handler: @escaping Handler) async -> Bool {
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        var received = false
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
            var eventName = "message"
            // 注意: AsyncLineSequence は空行を返さないため、data 行を受け取った時点でイベントを確定する
            for try await line in bytes.lines {
                if Task.isCancelled { break }
                if line.hasPrefix(":") { continue } // コメント行
                if line.hasPrefix("event:") {
                    eventName = fieldValue(line, prefix: "event:")
                } else if line.hasPrefix("data:") {
                    let data = fieldValue(line, prefix: "data:")
                    received = true
                    switch eventName {
                    case "ping":
                        break
                    case "change":
                        await handler(data)
                    default:
                        // "hello"（接続・再接続直後）は取りこぼしがあり得るので全件再取得させる
                        await handler(eventName)
                    }
                    eventName = "message"
                }
            }
        } catch {
            // 切断・タイムアウト。呼び出し側のループで再接続する。
        }
        return received
    }

    nonisolated private static func fieldValue(_ line: String, prefix: String) -> String {
        var value = line.dropFirst(prefix.count)
        if value.first == " " { value = value.dropFirst() }
        return String(value)
    }
}
