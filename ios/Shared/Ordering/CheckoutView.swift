import SwiftUI

/// カート確認 → サーバー見積 → 現地確認コード → 注文確定
struct CheckoutView: View {
    @Bindable var model: OrderFlowModel
    let onPlaced: (String) -> Void

    var body: some View {
        Form {
            if let reason = model.department?.orderUnavailableReason {
                Section {
                    Label(reason, systemImage: "pause.circle")
                        .foregroundStyle(.orange)
                }
            }

            Section("ご注文内容") {
                if model.cart.isEmpty {
                    Text("カートは空です")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.cart) { line in
                    CartLineRow(line: line) { newQuantity in
                        model.setQuantity(newQuantity, for: line.variantID)
                    }
                }
                .onDelete { offsets in
                    let ids = offsets.map { model.cart[$0].variantID }
                    ids.forEach { model.remove(variantID: $0) }
                }
            }

            Section {
                if model.isQuoting {
                    HStack {
                        ProgressView()
                        Text("金額を確認しています…")
                    }
                } else if let quote = model.quote {
                    ForEach(quote.items, id: \.variantId) { item in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading) {
                                Text(item.productName)
                                if !item.optionsLabel.isEmpty {
                                    Text(item.optionsLabel)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text("\(Fmt.yen(item.unitPrice)) × \(item.quantity)")
                                .font(.footnote.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(Fmt.yen(item.lineTotal))
                                .monospacedDigit()
                        }
                        .accessibilityElement(children: .combine)
                    }
                    HStack {
                        Text("合計")
                            .font(.title3.weight(.bold))
                        Spacer()
                        Text(Fmt.yen(quote.subtotal))
                            .font(.title2.weight(.bold).monospacedDigit())
                    }
                    .accessibilityElement(children: .combine)
                } else if let error = model.quoteError {
                    ErrorMessageView(message: error) { Task { await model.fetchQuote() } }
                }
            } header: {
                Text("お会計")
            } footer: {
                Text("金額はサーバーで確認したものです。お支払いは受け取り時に店頭でお願いします。クーポンは店頭のお会計でご提示ください。")
            }

            if model.needsSiteCode {
                Section {
                    SiteCodeField(code: $model.siteCode)
                } header: {
                    Text("確認コード")
                } footer: {
                    Text("会場の画面に表示されている3桁の数字を入力してください。コードは一定時間ごとに変わります。")
                }
            }

            if let error = model.submitError {
                Section {
                    ErrorMessageView(message: error)
                }
            }
        }
        .navigationTitle("注文の確認")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                Button {
                    Task {
                        if let token = await model.submit() {
                            onPlaced(token)
                        }
                    }
                } label: {
                    if model.isSubmitting {
                        HStack {
                            ProgressView()
                            Text("送信中…")
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        LargeButtonLabel(title: "注文を確定する", systemImage: "checkmark.circle")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!model.canSubmit)

                if model.needsSiteCode && !model.isSiteCodeComplete && !model.cart.isEmpty {
                    Text("確認コード（3桁）を入力すると注文できます")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            .background(.bar)
        }
        .task(id: model.cart) {
            await model.fetchQuote()
        }
        .onAppear { model.attachLiveUpdates() }
        .onDisappear { model.detachLiveUpdates() }
    }
}

private struct CartLineRow: View {
    let line: CartLine
    let onChange: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(line.productName)
                .font(.headline)
            if !line.optionsLabel.isEmpty {
                Text(line.optionsLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Stepper {
                Text("\(line.quantity)個")
                    .font(.body.monospacedDigit())
            } onIncrement: {
                onChange(min(line.quantity + 1, OrderFlowModel.maxQuantityPerLine))
            } onDecrement: {
                onChange(line.quantity - 1)
            }
            .frame(minHeight: 44)
            .accessibilityLabel("\(line.productName) \(line.optionsLabel) の数量")
            .accessibilityValue("\(line.quantity)個")
        }
        .padding(.vertical, 4)
    }
}
