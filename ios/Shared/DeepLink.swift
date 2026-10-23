import Foundation

/// App Clip の呼び出しURL・ユニバーサルリンクの解釈。
///
/// - https://<domain>/order/<部門ID>  … モバイル注文（App Clip の起動URL）
/// - https://<domain>/o/<token>       … 注文状況
/// - https://<domain>/r/<token>       … 予約確認・チケット
/// - https://<domain>/c/<token>       … クーポン
enum DeepLink: Equatable, Hashable, Sendable {
    case orderMenu(departmentID: String)
    case orderStatus(token: String)
    case reservation(token: String)
    case coupon(token: String)

    static func parse(_ url: URL) -> DeepLink? {
        let parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        guard parts.count >= 2 else { return nil }
        let value = parts[1]
        guard !value.isEmpty, value.count <= 200 else { return nil }
        switch parts[0] {
        case "order":
            return isUUID(value) ? .orderMenu(departmentID: value.lowercased()) : nil
        case "o":
            return .orderStatus(token: value)
        case "r":
            return .reservation(token: value)
        case "c":
            return .coupon(token: value)
        default:
            return nil
        }
    }

    /// 貼り付けられた文字列（URL）を解釈する
    static func parse(text: String) -> DeepLink? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else { return nil }
        return parse(url)
    }

    static func isUUID(_ value: String) -> Bool {
        UUID(uuidString: value) != nil
    }
}

/// QRコードの読み取り値から検証用トークンを取り出す（"…/c/<token>" のようなURL形式にも対応）。
enum ScannedValue {
    static func token(from raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let slash = value.lastIndex(of: "/") {
            value = String(value[value.index(after: slash)...])
        }
        if let marker = value.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            value = String(value[..<marker])
        }
        return value
    }
}
