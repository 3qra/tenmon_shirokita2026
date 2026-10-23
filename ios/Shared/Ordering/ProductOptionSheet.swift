import SwiftUI

/// 味・サイズなどの選択肢を選び、対応する組み合わせ（バリエーション）をカートに追加する。
/// 選択肢の種類・値は管理画面で追加・変更されるため、ここでは固定しない（仕様 4.1）。
struct ProductOptionSheet: View {
    let product: Product
    let onAdd: (Variant, Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selection: [String: String] = [:]
    @State private var quantity = 1

    var body: some View {
        NavigationStack {
            Form {
                ForEach(product.optionGroups) { group in
                    Section(group.name) {
                        ForEach(group.values) { value in
                            optionButton(group: group, value: value)
                        }
                    }
                }

                Section("数量") {
                    Stepper(value: $quantity, in: 1...OrderFlowModel.maxQuantityPerLine) {
                        Text("\(quantity)個")
                            .font(.title3.weight(.semibold).monospacedDigit())
                    }
                    .frame(minHeight: 44)
                }

                Section {
                    resolvedSummary
                }
            }
            .navigationTitle(product.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    if let variant = resolvedVariant, variant.isOnSale {
                        onAdd(variant, quantity)
                        dismiss()
                    }
                } label: {
                    LargeButtonLabel(title: "カートに追加", systemImage: "cart.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(resolvedVariant?.isOnSale != true)
                .padding()
                .background(.bar)
            }
            .onAppear(perform: preselect)
        }
    }

    private var resolvedVariant: Variant? {
        product.resolveVariant(selection: selection)
    }

    @ViewBuilder
    private var resolvedSummary: some View {
        if let variant = resolvedVariant {
            VStack(alignment: .leading, spacing: 6) {
                if !variant.label.isEmpty {
                    Text(variant.label)
                        .font(.headline)
                }
                HStack {
                    Text("\(Fmt.yen(variant.price)) × \(quantity)")
                        .font(.title3.monospacedDigit())
                    Spacer()
                    if !variant.isOnSale {
                        StatusBadge(text: variant.saleStatusLabel, systemImage: "nosign", tint: .red)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        } else if product.optionGroups.allSatisfy({ selection[$0.id] != nil }) {
            Label("この組み合わせは選べません", systemImage: "nosign")
                .foregroundStyle(.red)
        } else {
            Text("選択肢をすべて選んでください")
                .foregroundStyle(.secondary)
        }
    }

    private func optionButton(group: OptionGroup, value: OptionValue) -> some View {
        let isSelected = selection[group.id] == value.id
        let availability = availabilityText(group: group, value: value)
        return Button {
            selection[group.id] = value.id
        } label: {
            HStack {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                Text(value.name)
                    .font(.title3)
                    .foregroundStyle(.primary)
                Spacer()
                if let availability {
                    Text(availability)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityLabel(availability.map { "\(value.name)、\($0)" } ?? value.name)
    }

    /// 他の選択を固定したままこの値を選んだときの状態（売り切れ等）を補足表示する
    private func availabilityText(group: OptionGroup, value: OptionValue) -> String? {
        var hypothetical = selection
        hypothetical[group.id] = value.id
        guard product.optionGroups.allSatisfy({ hypothetical[$0.id] != nil }) else { return nil }
        guard let variant = product.resolveVariant(selection: hypothetical) else { return "選べません" }
        return variant.isOnSale ? nil : variant.saleStatusLabel
    }

    /// 販売中の最初の組み合わせを初期選択にする
    private func preselect() {
        guard selection.isEmpty else { return }
        let first = product.variants.first(where: \.isOnSale) ?? product.variants.first
        guard let first else { return }
        for group in product.optionGroups {
            if let valueID = group.values.first(where: { first.optionValueIds.contains($0.id) })?.id {
                selection[group.id] = valueID
            }
        }
    }
}
