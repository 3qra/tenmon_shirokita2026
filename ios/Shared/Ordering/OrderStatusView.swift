import SwiftUI

/// 注文状況。呼出番号を大きく表示する。
struct OrderStatusView: View {
    @State private var model: OrderStatusModel
    @State private var showCancelConfirm = false
    @ScaledMetric(relativeTo: .largeTitle) private var callNumberSize: CGFloat = 96

    init(token: String) {
        _model = State(initialValue: OrderStatusModel(token: token))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if let order = model.order {
                    content(order)
                } else if let error = model.loadError {
                    ErrorMessageView(message: error) { Task { await model.refresh() } }
                        .padding()
                } else {
                    ProgressView("注文を読み込み中…")
                        .frame(maxWidth: .infinity, minHeight: 200)
                }

                FreshnessFooter(lastUpdated: model.lastUpdated, isStale: model.isStale)
            }
            .padding()
        }
        .navigationTitle("注文状況")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        .sensoryFeedback(.success, trigger: model.order?.ready == true)
        .confirmationDialog("この注文を取り消しますか？", isPresented: $showCancelConfirm, titleVisibility: .visible) {
            Button("注文を取り消す", role: .destructive) {
                Task { await model.cancel() }
            }
            Button("やめる", role: .cancel) {}
        } message: {
            Text("取り消した注文は元に戻せません。")
        }
    }

    @ViewBuilder
    private func content(_ order: OrderDetail) -> some View {
        VStack(spacing: 8) {
            Text("呼出番号")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("\(order.callNumber)")
                .font(.system(size: callNumberSize, weight: .heavy, design: .rounded).monospacedDigit())
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(order.departmentName)
                .font(.headline)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("呼出番号 \(order.callNumber)、\(order.departmentName)")

        progressCard(order)

        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("お支払い")
                    .font(.headline)
                Spacer()
                StatusBadge(text: order.paymentStatusLabel,
                            systemImage: order.paymentStatus == "unpaid" ? "yensign.circle" : "checkmark.circle",
                            tint: order.paymentStatus == "unpaid" ? .orange : .green)
            }
            if order.paymentStatus == "unpaid" && !order.isCancelled {
                Text("受け取り時に店頭で \(Fmt.yen(order.total)) をお支払いください。")
                    .font(.callout)
            }
            Divider()
            ForEach(order.items) { item in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.productName)
                            .font(.body.weight(.semibold))
                        if let label = item.optionsLabel, !label.isEmpty {
                            Text(label)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text("× \(item.quantity)")
                        .monospacedDigit()
                    Spacer()
                    Label(item.cookStatusLabel, systemImage: CookStatus.systemImage(item.cookStatus))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
            Divider()
            if order.discount > 0 {
                HStack {
                    Text("割引")
                    Spacer()
                    Text("−\(Fmt.yen(order.discount))").monospacedDigit()
                }
            }
            HStack {
                Text("合計").font(.headline)
                Spacer()
                Text(Fmt.yen(order.total))
                    .font(.title3.weight(.bold).monospacedDigit())
            }
            .accessibilityElement(children: .combine)
            Text("注文日時 \(Fmt.dateTime(order.createdAt))")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))

        if order.looksCancellable {
            VStack(spacing: 6) {
                Button(role: .destructive) {
                    showCancelConfirm = true
                } label: {
                    if model.isCancelling {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        LargeButtonLabel(title: "注文を取り消す", systemImage: "xmark.circle")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(model.isCancelling)
                Text("取消は調理開始前・お支払い前のみできます。それ以降はスタッフにお声がけください。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        if let error = model.cancelError {
            ErrorMessageView(message: error)
        }

        Text("この画面を閉じても「あなたの注文」からいつでも確認できます。")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    private func progressCard(_ order: OrderDetail) -> some View {
        let progress = order.progress
        let tint: Color
        switch progress {
        case .ready: tint = .green
        case .cancelled: tint = .red
        case .cooking: tint = .orange
        default: tint = .blue
        }
        return VStack(spacing: 8) {
            Image(systemName: progress.systemImage)
                .font(.system(.largeTitle))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(progress.title)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            if progress == .ready {
                Text("店頭で呼出番号をお伝えください。")
                    .font(.callout)
            }
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(tint.opacity(0.6), lineWidth: 2))
        .accessibilityElement(children: .combine)
    }
}
