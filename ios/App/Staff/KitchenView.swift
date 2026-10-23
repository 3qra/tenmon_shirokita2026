import SwiftUI
import Observation

@MainActor
@Observable
final class KitchenModel {
    let session: StaffSession

    private(set) var departments: [Department] = []
    var selectedDepartmentID: String?
    private(set) var orders: [KitchenOrder] = []
    private(set) var fetchedAt: Date?
    private(set) var loadError: String?
    private(set) var actionError: String?
    /// 通信中の明細ID（二重タップ防止）
    private(set) var inFlight: Set<String> = []

    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var sseDepartmentID: String?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    private static let departmentKey = "gakusai.kitchenDepartmentId"

    init(session: StaffSession) {
        self.session = session
        self.selectedDepartmentID = UserDefaults.standard.string(forKey: Self.departmentKey)
    }

    var isStale: Bool { loadError != nil && fetchedAt != nil }

    func loadDepartments() async {
        guard let token = session.token else { return }
        do {
            let list: [Department] = try await APIClient.shared.get("/staff/departments", bearer: token)
            departments = list.filter { $0.kind != "planetarium" }
            if selectedDepartmentID == nil || !departments.contains(where: { $0.id == selectedDepartmentID }) {
                selectedDepartmentID = departments.first(where: { $0.kind == "food" })?.id ?? departments.first?.id
            }
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = session.message(for: error)
        }
    }

    func refresh() async {
        guard let token = session.token, let departmentID = selectedDepartmentID else { return }
        do {
            let response: KitchenResponse = try await APIClient.shared.get(
                "/staff/kitchen", query: [URLQueryItem(name: "department_id", value: departmentID)], bearer: token)
            guard departmentID == selectedDepartmentID else { return }
            orders = response.orders
            fetchedAt = Date()
            loadError = nil
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = session.message(for: error)
        }
    }

    /// 調理状態を変更する。from を送るので、他の端末で変わっていたら 409 になり最新を取り直す。
    func cook(item: KitchenItem, to newStatus: String) async {
        guard let token = session.token, !inFlight.contains(item.id) else { return }
        inFlight.insert(item.id)
        actionError = nil
        defer { inFlight.remove(item.id) }
        do {
            let _: CookResponse = try await APIClient.shared.post(
                "/staff/order-items/\(APIPath.segment(item.id))/cook",
                body: CookRequest(from: item.cookStatus, to: newStatus), bearer: token)
        } catch {
            actionError = session.message(for: error)
        }
        await refresh()
    }

    func start() {
        connectEvents()
        guard pollTask == nil else { return }
        // SSE が届かなくても20秒ごとに再取得する
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        sse?.stop()
        sse = nil
        sseDepartmentID = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func departmentChanged() async {
        UserDefaults.standard.set(selectedDepartmentID, forKey: Self.departmentKey)
        orders = []
        fetchedAt = nil
        connectEvents()
        await refresh()
    }

    private func connectEvents() {
        guard let departmentID = selectedDepartmentID, departmentID != sseDepartmentID else { return }
        sse?.stop()
        let client = SSEClient(topics: ["orders:\(departmentID)"]) { [weak self] _ in
            self?.scheduleRefresh()
        }
        sse = client
        sseDepartmentID = departmentID
        client.start()
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }
}

/// キッチン：注文番号・商品・経過時間・支払状態を大きく表示し、大きなボタンで調理状態を操作する（仕様 7.1）。
struct KitchenView: View {
    @State private var model: KitchenModel
    @State private var now = Date()

    init(session: StaffSession) {
        _model = State(initialValue: KitchenModel(session: session))
    }

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                Picker("部門", selection: $model.selectedDepartmentID) {
                    ForEach(model.departments) { department in
                        Text(department.name).tag(Optional(department.id))
                    }
                }
                .frame(minHeight: 44)
                FreshnessFooter(lastUpdated: model.fetchedAt, isStale: model.isStale)
                if let error = model.actionError {
                    ErrorMessageView(message: error)
                }
                if let error = model.loadError, model.fetchedAt == nil {
                    ErrorMessageView(message: error) { Task { await model.refresh() } }
                }
            }

            if model.orders.isEmpty && model.fetchedAt != nil {
                ContentUnavailableView("調理待ちの注文はありません", systemImage: "checkmark.circle")
            }

            ForEach(model.orders) { order in
                Section {
                    KitchenOrderHeader(order: order, extraSeconds: extraSeconds(at: now))
                    ForEach(order.items) { item in
                        KitchenItemRow(item: item,
                                       orderClosed: order.isCancelled,
                                       isBusy: model.inFlight.contains(item.id)) { newStatus in
                            Task { await model.cook(item: item, to: newStatus) }
                        }
                    }
                }
            }
        }
        .navigationTitle("キッチン")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .task {
            await model.loadDepartments()
            model.start()
            await model.refresh()
        }
        .task {
            // 経過時間の表示を30秒ごとに進める
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                now = Date()
            }
        }
        .onDisappear { model.stop() }
        .onChange(of: model.selectedDepartmentID) { _, _ in
            Task { await model.departmentChanged() }
        }
    }

    private func extraSeconds(at date: Date) -> Int {
        guard let fetchedAt = model.fetchedAt else { return 0 }
        return max(Int(date.timeIntervalSince(fetchedAt)), 0)
    }
}

private struct KitchenOrderHeader: View {
    let order: KitchenOrder
    let extraSeconds: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("No.\(order.callNumber)")
                    .font(.largeTitle.weight(.heavy).monospacedDigit())
                Spacer()
                Text("\(Fmt.elapsed(seconds: order.elapsedSec + extraSeconds))経過")
                    .font(.title3.monospacedDigit())
            }
            HStack(spacing: 8) {
                if order.isCancelled {
                    StatusBadge(text: "取消", systemImage: "xmark.octagon.fill", tint: .red)
                }
                if order.isUnpaid {
                    StatusBadge(text: order.unpaidWarning ? "未払い（長時間）" : "未払い",
                                systemImage: "yensign.circle", tint: .orange)
                } else {
                    StatusBadge(text: "支払済み", systemImage: "checkmark.circle", tint: .green)
                }
                if order.longWait {
                    StatusBadge(text: "長時間経過", systemImage: "clock.badge.exclamationmark", tint: .red)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct KitchenItemRow: View {
    let item: KitchenItem
    let orderClosed: Bool
    let isBusy: Bool
    let onChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.productName)
                        .font(.title3.weight(.bold))
                    if let label = item.optionsLabel, !label.isEmpty {
                        Text(label)
                            .font(.title3)
                    }
                }
                Text("× \(item.quantity)")
                    .font(.title2.weight(.heavy).monospacedDigit())
                Spacer()
                StatusBadge(text: CookStatus.label(item.cookStatus), systemImage: CookStatus.systemImage(item.cookStatus),
                            tint: tint)
            }
            .accessibilityElement(children: .combine)

            if !orderClosed {
                HStack(spacing: 12) {
                    switch item.cookStatus {
                    case "waiting":
                        actionButton("調理開始", systemImage: "flame", to: "cooking", prominent: true)
                    case "cooking":
                        actionButton("調理完了", systemImage: "checkmark.circle", to: "cooked", prominent: true)
                        actionButton("待ちに戻す", systemImage: "arrow.uturn.backward", to: "waiting", prominent: false)
                    case "cooked":
                        actionButton("調理中に戻す", systemImage: "arrow.uturn.backward", to: "cooking", prominent: false)
                    default:
                        EmptyView()
                    }
                }
                .disabled(isBusy)
                .overlay {
                    if isBusy { ProgressView() }
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var tint: Color {
        switch item.cookStatus {
        case "waiting": return .blue
        case "cooking": return .orange
        case "cooked": return .green
        default: return .secondary
        }
    }

    @ViewBuilder
    private func actionButton(_ title: String, systemImage: String, to status: String, prominent: Bool) -> some View {
        if prominent {
            Button { onChange(status) } label: {
                LargeButtonLabel(title: title, systemImage: systemImage)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
            Button { onChange(status) } label: {
                LargeButtonLabel(title: title, systemImage: systemImage)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }
}
