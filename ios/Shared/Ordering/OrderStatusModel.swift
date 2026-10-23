import Foundation
import Observation

/// 注文状況（呼出番号・調理状況・支払状態）。SSE と定期再取得の両方で更新する。
@MainActor
@Observable
final class OrderStatusModel {
    let token: String
    let api: APIClient

    private(set) var order: OrderDetail?
    private(set) var loadError: String?
    private(set) var lastUpdated: Date?
    private(set) var isCancelling = false
    private(set) var cancelError: String?

    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var sseDepartmentID: String?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(token: String, api: APIClient = .shared) {
        self.token = token
        self.api = api
    }

    /// 通信できず、表示が古い可能性があるか
    var isStale: Bool { loadError != nil && order != nil }

    func refresh() async {
        do {
            let detail: OrderDetail = try await api.get("/public/orders/by-token/\(APIPath.segment(token))")
            order = detail
            loadError = nil
            lastUpdated = Date()
            TokenStore.shared.upsert(order: SavedOrder(token: token, departmentName: detail.departmentName,
                                                       callNumber: detail.callNumber, createdAt: detail.createdAt))
            connectEvents(departmentID: detail.departmentId)
            if detail.isFinished { stopPolling() }
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }

    func start() {
        startPolling()
        if let departmentID = order?.departmentId {
            connectEvents(departmentID: departmentID)
        }
    }

    func stop() {
        stopPolling()
        sse?.stop()
        sse = nil
        sseDepartmentID = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func cancel() async {
        isCancelling = true
        cancelError = nil
        defer { isCancelling = false }
        do {
            let detail: OrderDetail = try await api.post("/public/orders/by-token/\(APIPath.segment(token))/cancel")
            order = detail
            lastUpdated = Date()
        } catch {
            cancelError = error.userMessage
            await refresh()
        }
    }

    // MARK: 更新

    private func connectEvents(departmentID: String) {
        guard sseDepartmentID != departmentID, pollTask != nil else { return }
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

    /// SSE が届かない環境（プロキシ等）でも更新されるよう、15秒ごとにも再取得する
    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
