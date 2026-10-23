import Foundation

/// 利用者の1回の操作（「注文を確定する」など）に対して Idempotency-Key を1つ発行し、
/// 再送時は同じキーを使い回す。
///
/// - 送信内容（fingerprint）が変わったら新しいキーを発行する（同じキーで異なる内容を送るとAPIは422を返すため）。
/// - 成功したら、または再送しても意味のない失敗（保存済みの4xx）なら破棄し、次の操作では新しいキーを使う。
/// - 通信断・5xx・409・429 の後はキーを保持し、再送で二重実行にならないようにする。
struct IdempotencyKeeper {
    private var currentKey: String?
    private var fingerprint: AnyHashable?

    /// 送信内容に対応するキーを返す。同じ内容の再送なら前回と同じキー。
    mutating func key(for fingerprint: AnyHashable) -> String {
        if let currentKey, self.fingerprint == fingerprint {
            return currentKey
        }
        let key = UUID().uuidString.lowercased()
        currentKey = key
        self.fingerprint = fingerprint
        return key
    }

    /// 成功したときに呼ぶ。
    mutating func succeeded() {
        currentKey = nil
        fingerprint = nil
    }

    /// 失敗したときに呼ぶ。再送すべき失敗ならキーを保持する。
    mutating func failed(with error: Error) {
        if let apiError = error as? APIError, !apiError.shouldKeepIdempotencyKey {
            currentKey = nil
            fingerprint = nil
        }
        // APIError 以外（想定外）の場合は安全側に倒してキーを保持する
    }
}
