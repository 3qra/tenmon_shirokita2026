import Foundation
import Observation

/// カートの1行（表示用の単価。確定金額はサーバーの見積・注文確定で決まる）
struct CartLine: Identifiable, Hashable, Sendable {
    var id: String { variantID }
    let variantID: String
    let productName: String
    let optionsLabel: String
    let displayUnitPrice: Int
    var quantity: Int
}

/// 1部門のモバイル注文（商品選択 → カート → 見積 → 確認コード → 確定）。
/// 価格・販売可否・受付可否はすべてAPIが判定し、アプリは表示と送信のみ行う。
@MainActor
@Observable
final class OrderFlowModel {
    let departmentID: String
    let api: APIClient

    private(set) var department: Department?
    private(set) var products: [Product] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var lastUpdated: Date?

    private(set) var cart: [CartLine] = []

    private(set) var quote: QuoteResponse?
    private(set) var isQuoting = false
    private(set) var quoteError: String?

    var siteCode: String = ""
    private(set) var isSubmitting = false
    private(set) var submitError: String?

    static let maxQuantityPerLine = 10

    @ObservationIgnored private var idempotency = IdempotencyKeeper()
    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(departmentID: String, api: APIClient = .shared) {
        self.departmentID = departmentID
        self.api = api
    }

    // MARK: 表示用

    var cartCount: Int { cart.reduce(0) { $0 + $1.quantity } }
    var estimatedTotal: Int { cart.reduce(0) { $0 + $1.displayUnitPrice * $1.quantity } }
    var needsSiteCode: Bool { department?.siteCodeEnabled == true }
    var isSiteCodeComplete: Bool { siteCode.count == 3 && siteCode.allSatisfy { $0.isASCII && $0.isNumber } }

    var canSubmit: Bool {
        guard !cart.isEmpty, quote != nil, !isSubmitting, !isQuoting else { return false }
        guard department?.orderUnavailableReason == nil else { return false }
        return !needsSiteCode || isSiteCodeComplete
    }

    // MARK: 読み込み

    func load() async {
        isLoading = products.isEmpty
        defer { isLoading = false }
        do {
            let response: ProductsResponse = try await api.get("/public/departments/\(APIPath.segment(departmentID))/products")
            department = response.department
            products = response.products
            loadError = nil
            lastUpdated = Date()
            pruneCart()
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }

    @ObservationIgnored private var liveUpdateUsers = 0

    /// 商品・部門の変更通知で再取得する。表示中の画面ごとに attach / detach を対で呼ぶ。
    func attachLiveUpdates() {
        liveUpdateUsers += 1
        guard sse == nil else { return }
        let client = SSEClient(topics: ["products", "departments"]) { [weak self] _ in
            self?.scheduleRefresh()
        }
        sse = client
        client.start()
    }

    func detachLiveUpdates() {
        liveUpdateUsers = max(liveUpdateUsers - 1, 0)
        guard liveUpdateUsers == 0 else { return }
        sse?.stop()
        sse = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }
            await self.load()
            if !self.cart.isEmpty, self.quote != nil {
                await self.fetchQuote()
            }
        }
    }

    /// 非公開・無効になった組み合わせをカートから外す
    private func pruneCart() {
        let available = Set(products.flatMap { $0.variants.map(\.id) })
        let before = cart.count
        cart.removeAll { !available.contains($0.variantID) }
        if cart.count != before { quote = nil }
    }

    // MARK: カート

    func add(product: Product, variant: Variant, quantity: Int) {
        guard quantity > 0 else { return }
        if let index = cart.firstIndex(where: { $0.variantID == variant.id }) {
            cart[index].quantity = min(cart[index].quantity + quantity, Self.maxQuantityPerLine)
        } else {
            cart.append(CartLine(variantID: variant.id, productName: product.name, optionsLabel: variant.label,
                                 displayUnitPrice: variant.price, quantity: min(quantity, Self.maxQuantityPerLine)))
        }
        quote = nil
        submitError = nil
    }

    func setQuantity(_ quantity: Int, for variantID: String) {
        guard let index = cart.firstIndex(where: { $0.variantID == variantID }) else { return }
        if quantity <= 0 {
            cart.remove(at: index)
        } else {
            cart[index].quantity = min(quantity, Self.maxQuantityPerLine)
        }
        quote = nil
        submitError = nil
    }

    func remove(variantID: String) {
        setQuantity(0, for: variantID)
    }

    private var itemRequests: [OrderItemRequest] {
        cart.map { OrderItemRequest(variantId: $0.variantID, quantity: $0.quantity) }
    }

    // MARK: 見積（サーバー計算）

    func fetchQuote() async {
        guard !cart.isEmpty else {
            quote = nil
            return
        }
        isQuoting = true
        defer { isQuoting = false }
        let request = QuoteRequest(departmentId: departmentID, items: itemRequests)
        do {
            let response: QuoteResponse = try await api.post("/public/orders/quote", body: request)
            // 見積中にカートが変わっていたら捨てる
            guard request.items == itemRequests else { return }
            quote = response
            quoteError = nil
        } catch let error where error.isCancellation {
            return
        } catch {
            quote = nil
            quoteError = error.userMessage
        }
    }

    // MARK: 注文確定

    /// 注文を確定し、成功したら注文状況用のトークンを返す。
    func submit() async -> String? {
        guard canSubmit else { return nil }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }

        let request = CreateOrderRequest(
            departmentId: departmentID,
            items: itemRequests,
            siteCode: needsSiteCode ? siteCode : nil,
            channel: ClientIdentity.channel
        )
        let key = idempotency.key(for: request)
        do {
            let response: CreateOrderResponse = try await api.post("/public/orders", body: request, idempotencyKey: key)
            idempotency.succeeded()
            TokenStore.shared.upsert(order: SavedOrder(
                token: response.accessToken,
                departmentName: department?.name ?? "",
                callNumber: response.callNumber,
                createdAt: Date()
            ))
            cart.removeAll()
            quote = nil
            siteCode = ""
            return response.accessToken
        } catch {
            idempotency.failed(with: error)
            submitError = error.userMessage
            if let apiError = error as? APIError {
                switch apiError.code {
                case "sold_out", "item_unavailable", "item_stopped", "invalid_item", "not_open", "mobile_order_off":
                    // 商品・営業状態が変わったので最新を取り直す
                    await load()
                    quote = nil
                case "site_code_invalid":
                    siteCode = ""
                default:
                    break
                }
            }
            return nil
        }
    }
}
