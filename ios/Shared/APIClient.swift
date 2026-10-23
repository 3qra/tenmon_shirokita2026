import Foundation

// MARK: - エラー

/// API呼び出しのエラー。`message` は利用者にそのまま表示できる日本語。
struct APIError: Error, LocalizedError, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// APIがエラー応答（{"error":{"code","message"}}）を返した
        case server
        /// 通信できなかった（サーバーで処理されたかは不明）
        case network
        /// 応答を解釈できなかった（サーバーでは処理済みの可能性がある）
        case decoding
        /// 呼び出し側で取り消された
        case cancelled
    }

    var kind: Kind
    /// HTTPステータス（server のときのみ）
    var status: Int?
    /// APIの機械判定用コード（例: site_code_invalid, sold_out）
    var code: String?
    var message: String

    var errorDescription: String? { message }

    var isUnauthorized: Bool { kind == .server && status == 401 }
    var isCancelled: Bool { kind == .cancelled }

    /// 同じ Idempotency-Key を保持したまま再送すべき失敗か。
    /// - サーバーは 5xx・409・429 のとき冪等記録を消すため、同じキーで再送できる。
    /// - 通信断・応答解釈失敗は処理済みの可能性があるため、同じキーで再送して二重実行を防ぐ。
    /// - それ以外の 4xx は応答が保存済みなので、次の操作では新しいキーを使う。
    var shouldKeepIdempotencyKey: Bool {
        switch kind {
        case .network, .decoding, .cancelled:
            return true
        case .server:
            guard let status else { return false }
            return status >= 500 || status == 409 || status == 429
        }
    }

    static func network(_ error: Error) -> APIError {
        if error is CancellationError {
            return APIError(kind: .cancelled, status: nil, code: nil, message: "処理を中止しました")
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled:
                return APIError(kind: .cancelled, status: nil, code: nil, message: "処理を中止しました")
            case .notConnectedToInternet, .dataNotAllowed:
                return APIError(kind: .network, status: nil, code: "offline",
                                message: "インターネットに接続されていません。電波の良い場所でもう一度お試しください")
            case .timedOut:
                return APIError(kind: .network, status: nil, code: "timeout",
                                message: "通信がタイムアウトしました。もう一度お試しください")
            default:
                break
            }
        }
        return APIError(kind: .network, status: nil, code: "network",
                        message: "サーバーに接続できませんでした。もう一度お試しください")
    }

    static let decodingFailed = APIError(kind: .decoding, status: nil, code: "decoding",
                                         message: "サーバーの応答を読み取れませんでした。画面を更新してください")
}

extension Error {
    /// 画面表示用の日本語メッセージ
    var userMessage: String {
        if let apiError = self as? APIError { return apiError.message }
        return "エラーが発生しました。もう一度お試しください"
    }

    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let apiError = self as? APIError { return apiError.isCancelled }
        if let urlError = self as? URLError { return urlError.code == .cancelled }
        return false
    }
}

private struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
    }
    let error: Body
}

// MARK: - パス

enum APIPath {
    /// パスの1区間として安全にエスケープする（トークンやQRの読み取り値に使う）。
    static func segment(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

// MARK: - 日付

/// ISO 8601 の日時を解釈する。小数秒の桁数（0〜9桁）やタイムゾーン表記（Z / +09:00）の違いを吸収する。
/// Go の RFC3339Nano と PostgreSQL の row_to_json（マイクロ秒）の両方に対応する。
enum ISODate {
    private final class Box: @unchecked Sendable {
        // ISO8601DateFormatter はスレッドセーフ（iOS 7+）
        let withFraction: ISO8601DateFormatter
        let withoutFraction: ISO8601DateFormatter
        let dateOnly: ISO8601DateFormatter

        init() {
            withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            withoutFraction = ISO8601DateFormatter()
            withoutFraction.formatOptions = [.withInternetDateTime]
            dateOnly = ISO8601DateFormatter()
            dateOnly.formatOptions = [.withFullDate]
            dateOnly.timeZone = TimeZone(identifier: "Asia/Tokyo")
        }
    }

    private static let box = Box()

    static func parse(_ raw: String) -> Date? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count == 10 {
            return box.dateOnly.date(from: text)
        }
        // "2026-10-17 10:00:00+09" のような空白区切りにも対応
        if let space = text.firstIndex(of: " "), text.distance(from: text.startIndex, to: space) == 10 {
            text.replaceSubrange(space...space, with: "T")
        }
        guard let dot = text.firstIndex(of: ".") else {
            return box.withoutFraction.date(from: text)
        }
        let fractionStart = text.index(after: dot)
        var fractionEnd = fractionStart
        while fractionEnd < text.endIndex, let ascii = text[fractionEnd].asciiValue, (48...57).contains(ascii) {
            fractionEnd = text.index(after: fractionEnd)
        }
        var fraction = String(text[fractionStart..<fractionEnd])
        if fraction.count > 3 { fraction = String(fraction.prefix(3)) }
        while fraction.count < 3 { fraction += "0" }
        let normalized = String(text[..<dot]) + "." + fraction + String(text[fractionEnd...])
        return box.withFraction.date(from: normalized)
    }
}

// MARK: - クライアント

/// Go API（/api/v1）への async/await クライアント。
struct APIClient: Sendable {
    static let shared = APIClient(baseURL: AppConfig.apiBaseURL)

    let baseURL: URL
    let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = ISODate.parse(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "日時を解釈できません: \(text)")
        }
        return decoder
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }

    /// `/api/v1` からの相対パス（例: "/public/departments"）でURLを作る。
    /// `path` の可変部分は呼び出し側で `APIPath.segment` を使ってエスケープしておく。
    func url(path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError(kind: .network, status: nil, code: "invalid_url", message: "接続先の設定が正しくありません")
        }
        var basePath = components.percentEncodedPath
        while basePath.hasSuffix("/") { basePath.removeLast() }
        components.percentEncodedPath = basePath + "/api/v1" + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw APIError(kind: .network, status: nil, code: "invalid_url", message: "接続先の設定が正しくありません")
        }
        return url
    }

    // MARK: 公開メソッド

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], bearer: String? = nil) async throws -> T {
        let request = try makeRequest(method: "GET", path: path, query: query, body: nil, bearer: bearer, idempotencyKey: nil)
        return try await send(request)
    }

    func post<T: Decodable, Body: Encodable>(_ path: String, body: Body, bearer: String? = nil,
                                             idempotencyKey: String? = nil) async throws -> T {
        let data: Data
        do {
            data = try Self.makeEncoder().encode(body)
        } catch {
            throw APIError(kind: .decoding, status: nil, code: "encoding", message: "送信内容を作成できませんでした")
        }
        let request = try makeRequest(method: "POST", path: path, query: [], body: data, bearer: bearer,
                                      idempotencyKey: idempotencyKey)
        return try await send(request)
    }

    /// 本文なしのPOST（APIには空のJSONオブジェクトを送る）
    func post<T: Decodable>(_ path: String, bearer: String? = nil, idempotencyKey: String? = nil) async throws -> T {
        let request = try makeRequest(method: "POST", path: path, query: [], body: Data("{}".utf8), bearer: bearer,
                                      idempotencyKey: idempotencyKey)
        return try await send(request)
    }

    /// JSON以外（.pkpass など）をそのまま取得する。エラー時はJSONのエラー本文を解釈する。
    func rawData(_ path: String, accept: String, bearer: String? = nil) async throws -> Data {
        var request = try makeRequest(method: "GET", path: path, query: [], body: nil, bearer: bearer, idempotencyKey: nil)
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let (data, _) = try await perform(request)
        return data
    }

    // MARK: 内部処理

    private func makeRequest(method: String, path: String, query: [URLQueryItem], body: Data?, bearer: String?,
                             idempotencyKey: String?) throws -> URLRequest {
        var request = URLRequest(url: try url(path: path, query: query))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Cookie認証を使わない要求であることを示す（Authorization のない POST に必要）
        request.setValue("ios", forHTTPHeaderField: "X-Requested-With")
        if let bearer, !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        } else {
            // 来場者識別（アプリ／App Clip ごとのランダム値）。同一人物の断定には使われない。
            request.setValue(ClientIdentity.id, forHTTPHeaderField: "X-Client-Id")
            request.setValue(ClientIdentity.kind, forHTTPHeaderField: "X-Client-Kind")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, _) = try await perform(request)
        do {
            return try Self.makeDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("[APIClient] decode \(T.self) failed: \(error)")
            #endif
            throw APIError.decodingFailed
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            throw APIError.network(error)
        }
        let (data, response) = result
        guard let http = response as? HTTPURLResponse else {
            throw APIError.decodingFailed
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.serverError(status: http.statusCode, data: data)
        }
        return (data, http)
    }

    private static func serverError(status: Int, data: Data) -> APIError {
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
            return APIError(kind: .server, status: status, code: envelope.error.code, message: envelope.error.message)
        }
        let message: String
        switch status {
        case 401: message = "ログインが必要です"
        case 403: message = "この操作の権限がありません"
        case 404: message = "見つかりませんでした"
        case 429: message = "操作が多すぎます。しばらく待ってからお試しください"
        case 500...: message = "サーバーでエラーが発生しました。しばらくしてからお試しください"
        default: message = "エラーが発生しました（\(status)）"
        }
        return APIError(kind: .server, status: status, code: nil, message: message)
    }
}

/// 本文が `{"ok": true}` などの簡単な応答
struct OKResponse: Decodable, Sendable {
    let ok: Bool?
}
