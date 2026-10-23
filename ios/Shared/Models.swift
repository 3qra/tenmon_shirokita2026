import Foundation

// APIのJSONは snake_case。APIClient のデコーダーは .convertFromSnakeCase なので、
// プロパティ名は「option_value_ids → optionValueIds」のように機械変換後の名前に合わせる（IDs ではなく Ids）。
// リクエストは .convertToSnakeCase でエンコードする。Go側は未知のフィールドを拒否するため、余計なフィールドを足さないこと。

// MARK: - 部門・商品

/// GET /public/departments の要素（departments.go `Department`）
struct Department: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let code: String
    let name: String
    /// food / planetarium / goods
    let kind: String
    /// before / open / paused / closed
    let businessStatus: String
    let mobileOrderEnabled: Bool
    let siteCodeEnabled: Bool
    let notice: String?
    let sortOrder: Int?

    var isOrderable: Bool { businessStatus == "open" && mobileOrderEnabled }

    var businessStatusLabel: String {
        switch businessStatus {
        case "before": return "営業前"
        case "open": return "営業中"
        case "paused": return "一時停止中"
        case "closed": return "営業終了"
        default: return businessStatus
        }
    }

    /// 注文できない理由（注文できるときは nil）
    var orderUnavailableReason: String? {
        if businessStatus != "open" {
            return "現在は\(businessStatusLabel)のため注文できません"
        }
        if !mobileOrderEnabled {
            return "現在スマートフォンからの注文を受け付けていません。店頭でご注文ください"
        }
        return nil
    }
}

/// GET /public/departments/{id}/products
struct ProductsResponse: Decodable, Sendable {
    let department: Department
    let products: [Product]
}

struct Product: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let departmentId: String
    let name: String
    let description: String?
    let needsCooking: Bool
    let sortOrder: Int?
    let optionGroups: [OptionGroup]
    let variants: [Variant]

    /// 販売中の組み合わせの価格帯（表示用。確定金額はサーバーの見積で決まる）
    var priceRangeText: String? {
        let prices = variants.filter(\.isOnSale).map(\.price)
        guard let low = prices.min(), let high = prices.max() else { return nil }
        return low == high ? Fmt.yen(low) : "\(Fmt.yen(low))〜\(Fmt.yen(high))"
    }

    var hasAvailableVariant: Bool { variants.contains(where: \.isOnSale) }

    /// 選択肢（グループID → 値ID）から組み合わせを決める。全グループを選んでいなければ nil。
    func resolveVariant(selection: [String: String]) -> Variant? {
        guard optionGroups.allSatisfy({ selection[$0.id] != nil }) else { return nil }
        let chosen = Set(optionGroups.compactMap { selection[$0.id] })
        return variants.first { Set($0.optionValueIds) == chosen }
    }
}

struct OptionGroup: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let sortOrder: Int?
    let active: Bool?
    let values: [OptionValue]
}

struct OptionValue: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let sortOrder: Int?
    let active: Bool?
}

struct Variant: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let price: Int
    let visibility: String?
    /// on_sale / sold_out / stopped
    let saleStatus: String
    let active: Bool?
    let sortOrder: Int?
    let optionValueIds: [String]
    /// 例: "しょうゆ / 中"
    let label: String

    var isOnSale: Bool { saleStatus == "on_sale" && active != false }

    var saleStatusLabel: String {
        switch saleStatus {
        case "on_sale": return "販売中"
        case "sold_out": return "売り切れ"
        case "stopped": return "販売停止中"
        default: return saleStatus
        }
    }
}

// MARK: - 注文

struct OrderItemRequest: Encodable, Hashable, Sendable {
    let variantId: String
    let quantity: Int
}

/// POST /public/orders/quote
struct QuoteRequest: Encodable, Hashable, Sendable {
    let departmentId: String
    let items: [OrderItemRequest]
}

struct QuoteResponse: Decodable, Hashable, Sendable {
    let items: [PricedItem]
    let subtotal: Int
}

struct PricedItem: Decodable, Hashable, Sendable {
    struct Option: Decodable, Hashable, Sendable {
        let group: String
        let value: String
        let valueId: String
    }
    let variantId: String
    let productId: String
    let productName: String
    let optionsLabel: String
    let options: [Option]?
    let unitPrice: Int
    let quantity: Int
    let lineTotal: Int
    let needsCooking: Bool
}

/// POST /public/orders（Idempotency-Key 必須）
struct CreateOrderRequest: Encodable, Hashable, Sendable {
    let departmentId: String
    let items: [OrderItemRequest]
    /// 現地確認コード（3桁・先頭のゼロを保持するため文字列）。不要なときは送らない。
    let siteCode: String?
    /// "ios" または "appclip"
    let channel: String
}

struct CreateOrderResponse: Decodable, Sendable {
    let id: String
    let callNumber: Int
    let total: Int
    let accessToken: String
    let statusUrl: String?
}

/// GET /public/orders/by-token/{token}（orders.go `orderJSON`）
struct OrderDetail: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let departmentId: String
    let departmentName: String
    let businessDay: String
    let callNumber: Int
    let channel: String
    /// accepted / cancelled / completed
    let status: String
    /// unpaid / paid / partially_refunded / refunded
    let paymentStatus: String
    /// pending / handed
    let handoffStatus: String
    let subtotal: Int
    let discount: Int
    let total: Int
    let createdAt: Date
    let handedAt: Date?
    let items: [OrderItem]
    let coupons: [OrderCoupon]
    /// 全有効明細の調理が終わり、受け渡しできる状態
    let ready: Bool

    var isCancelled: Bool { status == "cancelled" }
    var isHanded: Bool { handoffStatus == "handed" || status == "completed" }
    var isFinished: Bool { isCancelled || isHanded }
    var isCooking: Bool { items.contains { $0.cookStatus == "cooking" || $0.cookStatus == "cooked" } }

    /// 来場者による取消ができそうか（最終判断はAPI）。仕様：調理開始前・未払いのみ。
    var looksCancellable: Bool {
        status == "accepted" && paymentStatus == "unpaid" && !items.contains { $0.cookStatus == "cooking" || $0.cookStatus == "cooked" }
    }

    var progress: OrderProgress {
        if isCancelled { return .cancelled }
        if isHanded { return .handed }
        if ready { return .ready }
        if isCooking { return .cooking }
        return .accepted
    }

    var paymentStatusLabel: String {
        switch paymentStatus {
        case "unpaid": return "未払い"
        case "paid": return "支払済み"
        case "partially_refunded": return "一部返金済み"
        case "refunded": return "返金済み"
        default: return paymentStatus
        }
    }
}

enum OrderProgress: Sendable {
    case accepted, cooking, ready, handed, cancelled

    var title: String {
        switch self {
        case .accepted: return "受付済み（調理待ち）"
        case .cooking: return "調理中"
        case .ready: return "お受け取りいただけます"
        case .handed: return "お受け取り済み"
        case .cancelled: return "取り消されました"
        }
    }

    var systemImage: String {
        switch self {
        case .accepted: return "clock"
        case .cooking: return "flame"
        case .ready: return "bell.badge.fill"
        case .handed: return "checkmark.circle.fill"
        case .cancelled: return "xmark.circle"
        }
    }
}

struct OrderItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let productName: String
    let optionsLabel: String?
    let unitPrice: Int
    let quantity: Int
    let lineTotal: Int
    let discount: Int?
    let needsCooking: Bool
    /// waiting / cooking / cooked / cancelled / not_required
    let cookStatus: String
    let variantId: String?
    let productId: String?

    var cookStatusLabel: String { CookStatus.label(cookStatus) }
}

struct OrderCoupon: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let couponNo: String
    let name: String?
    let persons: Int
    let discount: Int
    let status: String
    let forfeitedPersons: Int?
}

enum CookStatus {
    static func label(_ status: String) -> String {
        switch status {
        case "waiting": return "調理待ち"
        case "cooking": return "調理中"
        case "cooked": return "調理済み"
        case "cancelled": return "取消"
        case "not_required": return "調理不要"
        default: return status
        }
    }

    static func systemImage(_ status: String) -> String {
        switch status {
        case "waiting": return "hourglass"
        case "cooking": return "flame"
        case "cooked": return "checkmark.circle.fill"
        case "cancelled": return "xmark.circle"
        default: return "minus.circle"
        }
    }
}

// MARK: - プラネタリウム（来場者）

/// GET /public/screenings の要素（planetarium.go handlePublicScreenings `pub`）
struct Screening: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let businessDay: String
    let startsAt: Date
    let endsAt: Date
    /// ○ / △ / ×
    let symbol: String
    /// 「受付停止中」「上映中止」など。通常は空文字。
    let statusText: String
    let advanceOpen: Bool
    let advanceAvailable: Bool
    let walkinAvailable: Bool
    /// scheduled / running / finished / cancelled
    let runStatus: String

    var canReserve: Bool { advanceOpen && advanceAvailable && runStatus == "scheduled" }
}

struct ScreeningsResponse: Decodable, Sendable {
    let screenings: [Screening]
    let serverTime: Date?
}

/// GET /public/screenings/{id}
struct ScreeningDetail: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let businessDay: String
    let startsAt: Date
    let endsAt: Date
    let symbol: String
    let statusText: String
    let advanceOpen: Bool
    let advanceAvailable: Bool
    let walkinAvailable: Bool
    /// この上映で今予約できる最大人数（空席と上限の小さい方）
    let maxPartySize: Int
    let runStatus: String

    var canReserve: Bool { advanceOpen && advanceAvailable && runStatus == "scheduled" && maxPartySize > 0 }
}

enum SeatSymbol {
    /// 記号を色だけに頼らず読み上げ・文字でも伝える
    static func description(_ symbol: String) -> String {
        switch symbol {
        case "○": return "空席あり"
        case "△": return "残りわずか"
        case "×": return "満席"
        default: return symbol
        }
    }
}

/// POST /public/reservations（Idempotency-Key 必須）
struct CreateReservationRequest: Encodable, Hashable, Sendable {
    let screeningId: String
    let name: String
    let partySize: Int
}

struct CreateReservationResponse: Decodable, Sendable {
    let id: String
    let reservationNo: String
    let accessToken: String?
    let url: String?
}

/// GET /public/reservations/by-token/{token}（planetarium.go reservationDetail）
struct ReservationDetail: Decodable, Identifiable, Hashable, Sendable {
    struct ScreeningInfo: Decodable, Hashable, Sendable {
        let id: String
        let title: String
        let startsAt: Date
        let endsAt: Date
        let runStatus: String
        let businessDay: String
        let cancelReason: String?
    }

    struct Ticket: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let seq: Int
        let ticketNo: String
        /// valid / void
        let status: String
        let admittedAt: Date?
        /// 入場QRに入れる検証用トークン
        let entryToken: String?

        var isAdmitted: Bool { admittedAt != nil }
        var isVoid: Bool { status == "void" }
    }

    struct Coupon: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let couponNo: String
        let name: String?
        let personsTotal: Int
        let personsRemaining: Int
        let status: String
        let validUntil: Date?
        /// クーポンQR・照会用トークン
        let token: String?
    }

    let id: String
    let reservationNo: String
    /// advance / walkin
    let kind: String
    let name: String
    let partySize: Int
    /// confirmed / cancelled_self / cancelled_staff / cancelled_screening
    let status: String
    let cancelReason: String?
    let createdAt: Date
    let cancelledAt: Date?
    let screening: ScreeningInfo
    let tickets: [Ticket]
    let coupons: [Coupon]
    /// 取消応答には含まれないため optional
    let walletEnabled: Bool?

    var isConfirmed: Bool { status == "confirmed" }
    var hasAdmittedTicket: Bool { tickets.contains(where: \.isAdmitted) }

    var statusLabel: String {
        switch status {
        case "confirmed": return "予約確定"
        case "cancelled_self": return "取消済み（ご本人による取消）"
        case "cancelled_staff": return "取消済み（スタッフによる取消）"
        case "cancelled_screening": return "取消済み（上映中止のため）"
        default: return status
        }
    }
}

// MARK: - クーポン

/// 発券時に固定された条件（coupons.go couponSnapshot）。表示に使う項目のみ。
struct CouponConditions: Decodable, Hashable, Sendable {
    let name: String?
    let description: String?
    /// fixed / percent
    let discountType: String?
    let discountValue: Int?
    /// order / items
    let scope: String?
    let itemsPerPerson: Int?
    let maxDiscount: Int?
    /// per_person / group
    let holderMode: String?
    let splittable: Bool?
    let combinable: Bool?
    let validFrom: Date?
    let validUntil: Date?
}

/// GET /public/coupons/by-token/{token}
struct PublicCoupon: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let couponNo: String
    let name: String?
    let description: String?
    let conditions: CouponConditions?
    let personsTotal: Int
    let personsRemaining: Int
    /// active / used / revoked
    let status: String
    let validFrom: Date?
    let validUntil: Date?
    let createdAt: Date?
    let summary: String?
    let token: String?

    var statusLabel: String { CouponStatus.label(status) }
}

enum CouponStatus {
    static func label(_ status: String) -> String {
        switch status {
        case "active": return "利用できます"
        case "used": return "使用済み"
        case "revoked": return "失効"
        default: return status
        }
    }
}

// MARK: - スタッフ

struct StaffUser: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let loginId: String
    let roles: [String]

    func has(any wanted: [String]) -> Bool { roles.contains { wanted.contains($0) } }

    static func roleLabel(_ role: String) -> String {
        switch role {
        case "admin": return "管理者"
        case "cashier": return "会計担当"
        case "kitchen": return "キッチン担当"
        case "reception": return "プラネ受付担当"
        case "treasurer": return "会計責任者"
        case "member": return "部員"
        case "display": return "表示端末"
        default: return role
        }
    }
}

/// POST /auth/login
struct LoginRequest: Encodable, Sendable {
    let loginId: String
    let password: String
}

struct LoginResponse: Decodable, Sendable {
    let token: String
    let expiresAt: Date?
    let staff: StaffUser
}

/// GET /auth/me
struct MeResponse: Decodable, Sendable {
    let staff: StaffUser
    let unreadNotifications: Int?
}

/// GET /staff/screenings（planetarium.go screeningRow。使う項目のみ）
struct StaffScreening: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let businessDay: String
    let startsAt: Date
    let endsAt: Date
    let capacity: Int
    let taken: Int
    let admittedCount: Int
    let symbol: String
    let statusText: String
    let runStatus: String
}

struct StaffScreeningsResponse: Decodable, Sendable {
    let screenings: [StaffScreening]
    let serverTime: Date?
}

/// POST /staff/checkin/verify, /staff/checkin。token か ticketNo のどちらかを送る。
struct CheckinRequest: Encodable, Hashable, Sendable {
    let token: String?
    let ticketNo: String?
    let screeningId: String?
}

/// planetarium.go checkinResult
struct CheckinResult: Decodable, Hashable, Sendable {
    /// ok / admitted / already_admitted / cancelled / wrong_screening / screening_cancelled / finished / not_found
    let result: String
    let message: String
    let ticket: CheckinTicket?
}

struct CheckinTicket: Decodable, Hashable, Sendable {
    let id: String
    let ticketNo: String
    let seq: Int
    let status: String
    let reservationStatus: String
    let reservationNo: String
    let name: String
    let partySize: Int
    let screeningId: String
    let title: String
    let startsAt: Date
    let runStatus: String
    let admittedAt: Date?
}

/// GET /staff/coupons/verify/{token}（読み取りのみ。消費しない）
struct StaffCouponVerification: Decodable, Hashable, Sendable {
    let id: String
    let couponNo: String
    let status: String
    let personsTotal: Int
    let personsRemaining: Int
    let conditions: CouponConditions?
    let usable: Bool
    let summary: String?
    /// 使えない理由（usable=false のとき）
    let reason: String?
}

/// GET /staff/kitchen?department_id=
struct KitchenResponse: Decodable, Sendable {
    let orders: [KitchenOrder]
    let serverTime: Date?
}

struct KitchenOrder: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let callNumber: Int
    let paymentStatus: String
    let status: String
    let channel: String
    let createdAt: Date
    let elapsedSec: Int
    let longWait: Bool
    let unpaidWarning: Bool
    let items: [KitchenItem]

    var isCancelled: Bool { status == "cancelled" }
    var isUnpaid: Bool { paymentStatus == "unpaid" }
}

struct KitchenItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let productName: String
    let optionsLabel: String?
    let quantity: Int
    let cookStatus: String
    let updatedAt: Date?
}

/// POST /staff/order-items/{id}/cook {from, to}
struct CookRequest: Encodable, Hashable, Sendable {
    let from: String
    let to: String
}

struct CookResponse: Decodable, Sendable {
    let ok: Bool?
    let cookStatus: String?
}
