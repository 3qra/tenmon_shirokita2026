import SwiftUI

/// 状態表示のバッジ。色だけに頼らず、必ずアイコンと文字を併記する（仕様 14）。
struct StatusBadge: View {
    let text: String
    let systemImage: String
    var tint: Color = .secondary

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .foregroundStyle(tint)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(tint.opacity(0.5), lineWidth: 1))
            .accessibilityElement(children: .combine)
    }
}

/// 画面幅いっぱいの大きなボタン用ラベル
struct LargeButtonLabel: View {
    let title: String
    var systemImage: String?

    var body: some View {
        Group {
            if let systemImage {
                Label(title, systemImage: systemImage)
            } else {
                Text(title)
            }
        }
        .font(.headline)
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.vertical, 4)
    }
}

/// エラーの表示（再試行ボタン付き）
struct ErrorMessageView: View {
    let message: String
    var retryTitle: String = "もう一度試す"
    var retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button(retryTitle, action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// 最終更新時刻と通信状態。通信できていないときに古い情報が最新に見えないようにする（仕様 18）。
struct FreshnessFooter: View {
    let lastUpdated: Date?
    let isStale: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isStale {
                Image(systemName: "wifi.exclamationmark")
                Text("通信できません。表示が古い可能性があります")
            } else {
                Image(systemName: "arrow.clockwise")
                if let lastUpdated {
                    Text("最終更新 \(Fmt.timeWithSeconds(lastUpdated))")
                } else {
                    Text("読み込み中…")
                }
            }
        }
        .font(.footnote)
        .foregroundStyle(isStale ? Color.orange : Color.secondary)
        .accessibilityElement(children: .combine)
    }
}

/// 3桁の現地確認コード入力。数字以外を取り除き、先頭のゼロ（例: 007）を保持する。
struct SiteCodeField: View {
    @Binding var code: String

    var body: some View {
        TextField("000", text: $code)
            .keyboardType(.numberPad)
            .font(.system(.largeTitle, design: .monospaced).weight(.bold))
            .multilineTextAlignment(.center)
            .frame(minHeight: 56)
            .accessibilityLabel("確認コード（3桁の数字）")
            .onChange(of: code) { _, newValue in
                let digits = String(newValue.filter { $0.isASCII && $0.isNumber }.prefix(3))
                if digits != newValue { code = digits }
            }
    }
}
