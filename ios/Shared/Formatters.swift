import Foundation

/// 表示用の書式。時刻は常に日本時間（Asia/Tokyo）で表示する（仕様 17）。
enum Fmt {
    static let japan = Locale(identifier: "ja_JP")
    static let tokyo = TimeZone(identifier: "Asia/Tokyo") ?? .current

    private final class DateFormatterBox: @unchecked Sendable {
        // DateFormatter は iOS 7 以降スレッドセーフ。生成後に設定を変更しない。
        let formatter: DateFormatter

        init(_ format: String) {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "ja_JP")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
            formatter.dateFormat = format
            self.formatter = formatter
        }
    }

    private static let timeBox = DateFormatterBox("H:mm")
    private static let timeWithSecondsBox = DateFormatterBox("H:mm:ss")
    private static let dayBox = DateFormatterBox("M月d日(E)")
    private static let dateTimeBox = DateFormatterBox("M月d日(E) H:mm")
    private static let ymdBox = DateFormatterBox("yyyy-MM-dd")

    /// 1200 → "1,200円"
    static func yen(_ value: Int) -> String {
        "\(value.formatted(.number.locale(japan)))円"
    }

    /// "10:00"
    static func time(_ date: Date) -> String { timeBox.formatter.string(from: date) }

    /// "10:00:05"（最終更新の表示用）
    static func timeWithSeconds(_ date: Date) -> String { timeWithSecondsBox.formatter.string(from: date) }

    /// "10月17日(土)"
    static func day(_ date: Date) -> String { dayBox.formatter.string(from: date) }

    /// "10月17日(土) 10:00"
    static func dateTime(_ date: Date) -> String { dateTimeBox.formatter.string(from: date) }

    /// "10:00〜10:10"
    static func timeRange(_ start: Date, _ end: Date) -> String { "\(time(start))〜\(time(end))" }

    /// 営業日 "2026-10-17" → "10月17日(土)"
    static func businessDay(_ value: String) -> String {
        guard let date = ymdBox.formatter.date(from: value) else { return value }
        return day(date)
    }

    /// 経過時間 → "45秒" / "12分"
    static func elapsed(seconds: Int) -> String {
        if seconds < 60 { return "\(max(seconds, 0))秒" }
        return "\(seconds / 60)分"
    }
}
