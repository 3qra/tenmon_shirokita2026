import SwiftUI
import Observation

@MainActor
@Observable
final class CouponScanModel {
    let session: StaffSession

    private(set) var verification: StaffCouponVerification?
    private(set) var isWorking = false
    private(set) var errorMessage: String?
    var manualToken = ""

    init(session: StaffSession) {
        self.session = session
    }

    var isShowingResult: Bool { verification != nil || errorMessage != nil }

    /// クーポンを照会する（読み取りだけでは消費しない。適用は会計確定時にサーバーが行う）
    func verify(raw: String) async {
        guard let token = session.token, !isWorking else { return }
        let couponToken = ScannedValue.token(from: raw)
        guard !couponToken.isEmpty else { return }
        isWorking = true
        errorMessage = nil
        verification = nil
        defer { isWorking = false }
        do {
            verification = try await APIClient.shared.get("/staff/coupons/verify/\(APIPath.segment(couponToken))",
                                                          bearer: token)
        } catch {
            errorMessage = session.message(for: error)
        }
    }

    func reset() {
        verification = nil
        errorMessage = nil
        manualToken = ""
    }
}

/// クーポン確認（会計担当）。条件・残り人数を表示する。適用・消費は Web の会計画面で行う。
struct CouponScanView: View {
    @State private var model: CouponScanModel

    init(session: StaffSession) {
        _model = State(initialValue: CouponScanModel(session: session))
    }

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.isShowingResult {
                    result
                } else {
                    QRScannerPanel(isActive: !model.isWorking) { value in
                        Task { await model.verify(raw: value) }
                    }
                    if model.isWorking {
                        ProgressView("照会しています…")
                            .frame(maxWidth: .infinity)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("コード・URLを貼り付けて照会")
                        .font(.headline)
                    HStack {
                        TextField("クーポンのコードまたはURL", text: $model.manualToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                            .frame(minHeight: 44)
                        Button("照会") {
                            Task { await model.verify(raw: model.manualToken) }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.manualToken.trimmingCharacters(in: .whitespaces).isEmpty || model.isWorking)
                    }
                }

                Text("この画面ではクーポンは使用されません。割引の適用・人数の消費は、Web の会計画面で会計を確定したときに行われます。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
        .navigationTitle("クーポン確認")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(trigger: model.verification?.usable) { _, usable in
            guard let usable else { return nil }
            return usable ? .success : .error
        }
    }

    @ViewBuilder
    private var result: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let coupon = model.verification {
                HStack(spacing: 12) {
                    Image(systemName: coupon.usable ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(coupon.usable ? Color.green : Color.red)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading) {
                        Text(coupon.usable ? "利用できます" : "利用できません")
                            .font(.title.weight(.heavy))
                        Text(CouponStatus.label(coupon.status))
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                if let reason = coupon.reason, !coupon.usable {
                    Text(reason)
                        .font(.title3)
                        .foregroundStyle(.red)
                }
                Text(coupon.conditions?.name ?? "クーポン")
                    .font(.title3.weight(.bold))
                if let summary = coupon.summary {
                    Text(summary)
                        .font(.headline)
                }
                Text("クーポン番号 \(coupon.couponNo)")
                    .monospacedDigit()
                Text("残り \(coupon.personsRemaining) / \(coupon.personsTotal) 人分")
                    .font(.title2.weight(.bold))
                if coupon.conditions?.splittable == false && coupon.personsRemaining > 1 {
                    Label("分割利用不可：一部の人数だけ使うと、残りの人数分は失効します（会計前にお客様へ伝えてください）",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                if let until = coupon.conditions?.validUntil {
                    Text("有効期限 \(Fmt.dateTime(until))")
                        .font(.callout)
                }
            }
            if let message = model.errorMessage {
                ErrorMessageView(message: message)
            }
            Button {
                model.reset()
            } label: {
                LargeButtonLabel(title: "次のクーポンを読み取る", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}
