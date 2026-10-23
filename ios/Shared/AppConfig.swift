import Foundation

/// ビルド設定（project.yml → Info.plist）から読み込む接続先。
enum AppConfig {
    /// Go API のオリジン（例: https://example.com）。パス /api/v1 は APIClient が付与する。
    static let apiBaseURL: URL = url(forInfoKey: "API_BASE_URL") ?? URL(string: "https://example.com")!

    /// Web（Next.js）のオリジン。スタッフ用Web画面や来場者向けURLの表示に使う。
    static let webBaseURL: URL = url(forInfoKey: "WEB_BASE_URL") ?? apiBaseURL

    private static func url(forInfoKey key: String) -> URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 変数が展開されていない（"$(API_BASE_URL)" のまま）場合は無視する
        guard !value.isEmpty, !value.hasPrefix("$("), let url = URL(string: value), url.scheme != nil else { return nil }
        return url
    }
}
