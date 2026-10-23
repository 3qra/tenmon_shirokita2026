import SwiftUI

/// クーポンの詳細と提示用QR（GET /public/coupons/by-token/{token}）
struct CouponDetailView: View {
    let token: String

    @State private var coupon: PublicCoupon?
    @State private var loadError: String?
    @State private var lastUpdated: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let coupon {
                    content(coupon)
                } else if let loadError {
                    ErrorMessageView(message: loadError) { Task { await load() } }
                } else {
                    ProgressView("クーポンを読み込み中…")
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
                FreshnessFooter(lastUpdated: lastUpdated, isStale: loadError != nil && coupon != nil)
                    .frame(maxWidth: .infinity)
            }
            .padding()
        }
        .navigationTitle("クーポン")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func content(_ coupon: PublicCoupon) -> some View {
        let isActive = coupon.status == "active" && coupon.personsRemaining > 0
        VStack(alignment: .leading, spacing: 8) {
            StatusBadge(text: coupon.statusLabel,
                        systemImage: isActive ? "checkmark.circle" : "xmark.circle",
                        tint: isActive ? .green : .secondary)
            Text(coupon.name ?? "クーポン")
                .font(.title2.weight(.bold))
            if let summary = coupon.summary, !summary.isEmpty {
                Text(summary)
                    .font(.headline)
            }
            if let description = coupon.description, !description.isEmpty {
                Text(description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("クーポン番号")
                    .foregroundStyle(.secondary)
                Text(coupon.couponNo)
                    .font(.headline.monospacedDigit())
            }
            Text("残り \(coupon.personsRemaining) / \(coupon.personsTotal) 人分")
                .font(.title3.weight(.semibold))
            if let until = coupon.validUntil {
                Text("有効期限：\(Fmt.dateTime(until))まで")
            }
            if let from = coupon.validFrom, from > Date() {
                Text("利用開始：\(Fmt.dateTime(from))から")
            }
            if coupon.conditions?.splittable == false {
                Label("分割利用できません。1回の会計で使わなかった人数分は失効します。", systemImage: "exclamationmark.circle")
                    .font(.footnote)
            }
            if coupon.conditions?.combinable == false {
                Label("他のクーポンと併用できません。", systemImage: "info.circle")
                    .font(.footnote)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        if isActive {
            QRCodeView(value: token, label: "クーポンのQRコード、番号 \(coupon.couponNo)")
                .frame(maxWidth: 300)
                .frame(maxWidth: .infinity)
            Text("お会計のときにスタッフへこの画面を見せてください。読み取っただけでは使用されません。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        do {
            let loaded: PublicCoupon = try await APIClient.shared.get("/public/coupons/by-token/\(APIPath.segment(token))")
            coupon = loaded
            loadError = nil
            lastUpdated = Date()
            TokenStore.shared.upsert(coupon: SavedCoupon(token: token, couponNo: loaded.couponNo,
                                                         name: loaded.name ?? "クーポン", savedAt: Date()))
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }
}
