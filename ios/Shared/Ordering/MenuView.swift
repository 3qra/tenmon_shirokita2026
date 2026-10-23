import SwiftUI

/// 商品一覧（メニュー）
struct MenuView: View {
    let model: OrderFlowModel
    let onCheckout: () -> Void

    @State private var selectedProduct: Product?

    var body: some View {
        List {
            if let department = model.department {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        if let reason = department.orderUnavailableReason {
                            StatusBadge(text: "現在注文できません", systemImage: "pause.circle", tint: .orange)
                            Text(reason)
                                .font(.callout)
                        } else {
                            StatusBadge(text: "注文受付中", systemImage: "checkmark.circle", tint: .green)
                        }
                        if let notice = department.notice, !notice.isEmpty {
                            Text(notice)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            if let error = model.loadError {
                Section {
                    ErrorMessageView(message: error) { Task { await model.load() } }
                }
            }

            Section {
                if model.isLoading {
                    ProgressView("メニューを読み込み中…")
                        .frame(maxWidth: .infinity, minHeight: 60)
                } else if model.products.isEmpty && model.loadError == nil {
                    Text("現在注文できる商品はありません")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.products) { product in
                    Button {
                        selectedProduct = product
                    } label: {
                        ProductRow(product: product)
                    }
                    .disabled(!product.hasAvailableVariant)
                }
            } header: {
                Text("メニュー")
            } footer: {
                Text("価格はダミーの場合があります。注文前の確認画面で、サーバーが計算した金額を表示します。")
            }
        }
        .navigationTitle(model.department?.name ?? "メニュー")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .safeAreaInset(edge: .bottom) {
            if !model.cart.isEmpty {
                Button(action: onCheckout) {
                    HStack {
                        Label("カートを見る", systemImage: "cart.fill")
                        Spacer()
                        Text("\(model.cartCount)点")
                            .monospacedDigit()
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                .background(.bar)
                .accessibilityHint("注文内容の確認と確定に進みます")
            }
        }
        .sheet(item: $selectedProduct) { product in
            ProductOptionSheet(product: product) { variant, quantity in
                model.add(product: product, variant: variant, quantity: quantity)
            }
        }
        .task { await model.load() }
        .onAppear { model.attachLiveUpdates() }
        .onDisappear { model.detachLiveUpdates() }
    }
}

private struct ProductRow: View {
    let product: Product

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(product.name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                if let description = product.description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let price = product.priceRangeText {
                    Text(price)
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(.primary)
                }
                if !product.hasAvailableVariant {
                    StatusBadge(text: "売り切れ・販売停止中", systemImage: "nosign", tint: .red)
                }
            }
            Spacer()
            if product.hasAvailableVariant {
                Image(systemName: "plus.circle.fill")
                    .font(.title)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(product.hasAvailableVariant ? "味やサイズを選んでカートに追加します" : "")
    }
}
