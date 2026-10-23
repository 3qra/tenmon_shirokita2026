import Foundation

/// 来場者識別（X-Client-Id / X-Client-Kind）。
///
/// - 通常版アプリと App Clip はそれぞれ別のランダムなUUIDを持つ（App Clip は "appclip"）。
/// - サーバーはこの値をハッシュ化して、未払い注文数・予約数の上限やブロック判定に使う。
/// - 端末の永久識別ではない。アプリ／App Clip の削除やデータ消去で変わることがある（仕様 6.2）。
enum ClientIdentity {
    #if APPCLIP
    static let kind = "appclip"
    #else
    static let kind = "ios"
    #endif

    /// 注文作成時の channel（API は "ios" / "appclip" を受け付ける）
    static var channel: String { kind }

    static let id: String = loadOrCreate()

    private static let storageKey = "gakusai.clientId"

    private static func loadOrCreate() -> String {
        #if APPCLIP
        // App Clip はキーチェーンを親アプリと共有しないため UserDefaults に保存する
        if let saved = UserDefaults.standard.string(forKey: storageKey), saved.count >= 16 {
            return saved
        }
        let created = UUID().uuidString.lowercased()
        UserDefaults.standard.set(created, forKey: storageKey)
        return created
        #else
        if let saved = KeychainStore.string(for: storageKey), saved.count >= 16 {
            return saved
        }
        if let saved = UserDefaults.standard.string(forKey: storageKey), saved.count >= 16 {
            KeychainStore.set(saved, for: storageKey)
            return saved
        }
        let created = UUID().uuidString.lowercased()
        if !KeychainStore.set(created, for: storageKey) {
            UserDefaults.standard.set(created, forKey: storageKey)
        }
        return created
        #endif
    }
}
