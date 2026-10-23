import SwiftUI

enum OrderRoute: Hashable {
    case menu(departmentID: String)
    case checkout(departmentID: String)
    case status(token: String)
}

/// 部門ごとの注文モデルを保持する（ナビゲーションで画面を行き来してもカートを保つ）。
/// 画面描画中に生成しても再描画を起こさないよう、あえて @Observable にしない。
@MainActor
final class OrderFlowRegistry {
    private var flows: [String: OrderFlowModel] = [:]

    func flow(for departmentID: String) -> OrderFlowModel {
        if let existing = flows[departmentID] { return existing }
        let created = OrderFlowModel(departmentID: departmentID)
        flows[departmentID] = created
        return created
    }
}

/// モバイル注文のトップ（App Clip と通常版アプリの「注文」タブで共用）。
struct OrderHomeView: View {
    /// 外部（App Clip の呼び出しURL・ユニバーサルリンク）からの遷移要求
    @Binding var pendingLink: DeepLink?

    @State private var path: [OrderRoute] = []
    @State private var registry = OrderFlowRegistry()
    @State private var departments: [Department] = []
    @State private var loadError: String?
    @State private var isLoading = false

    private var store: TokenStore { TokenStore.shared }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let loadError {
                    Section {
                        ErrorMessageView(message: loadError) { Task { await loadDepartments() } }
                    }
                }

                Section {
                    if isLoading && departments.isEmpty {
                        ProgressView("読み込み中…")
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                    ForEach(orderableDepartments) { department in
                        NavigationLink(value: OrderRoute.menu(departmentID: department.id)) {
                            DepartmentRow(department: department)
                        }
                    }
                } header: {
                    Text("注文できるお店")
                } footer: {
                    Text("お支払いは受け取り時に店頭でお願いします。")
                }

                if !store.orders.isEmpty {
                    Section("あなたの注文") {
                        ForEach(store.orders) { order in
                            NavigationLink(value: OrderRoute.status(token: order.token)) {
                                SavedOrderRow(order: order)
                            }
                        }
                        .onDelete { offsets in
                            let tokens = offsets.map { store.orders[$0].token }
                            tokens.forEach { store.removeOrder(token: $0) }
                        }
                    }
                }
            }
            .navigationTitle("モバイル注文")
            .refreshable { await loadDepartments() }
            .task { await loadDepartments() }
            .navigationDestination(for: OrderRoute.self) { route in
                destination(for: route)
            }
        }
        .onChange(of: pendingLink) { _, link in
            handle(link)
        }
        .onAppear {
            handle(pendingLink)
        }
    }

    private var orderableDepartments: [Department] {
        departments.filter { $0.kind != "planetarium" }
    }

    @ViewBuilder
    private func destination(for route: OrderRoute) -> some View {
        switch route {
        case .menu(let departmentID):
            MenuView(model: registry.flow(for: departmentID)) {
                path.append(.checkout(departmentID: departmentID))
            }
        case .checkout(let departmentID):
            CheckoutView(model: registry.flow(for: departmentID)) { token in
                // 確定後は「注文状況」だけを残し、戻るでトップへ戻れるようにする
                path = [.status(token: token)]
            }
        case .status(let token):
            OrderStatusView(token: token)
        }
    }

    private func handle(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .orderMenu(let departmentID):
            path = [.menu(departmentID: departmentID)]
            pendingLink = nil
        case .orderStatus(let token):
            path = [.status(token: token)]
            pendingLink = nil
        case .reservation, .coupon:
            // 注文以外のリンクは呼び出し元で処理する
            break
        }
    }

    private func loadDepartments() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let list: [Department] = try await APIClient.shared.get("/public/departments")
            departments = list
            loadError = nil
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }
}

private struct DepartmentRow: View {
    let department: Department

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(department.name)
                .font(.title3.weight(.bold))
            if let reason = department.orderUnavailableReason {
                StatusBadge(text: department.mobileOrderEnabled ? department.businessStatusLabel : "スマホ注文停止中",
                            systemImage: "pause.circle", tint: .orange)
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                StatusBadge(text: "注文受付中", systemImage: "checkmark.circle", tint: .green)
            }
            if let notice = department.notice, !notice.isEmpty {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct SavedOrderRow: View {
    let order: SavedOrder

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("呼出番号")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(order.callNumber)")
                    .font(.title.weight(.bold).monospacedDigit())
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(order.departmentName.isEmpty ? "注文" : order.departmentName)
                    .font(.headline)
                Text(Fmt.dateTime(order.createdAt))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
