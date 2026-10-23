import Foundation
import Observation

/// 来場者がこの端末で作成・受け取った注文／予約／クーポンのアクセス用トークン。
/// トークンは秘密値なのでログや解析基盤に送らない（仕様 9.2）。
struct SavedOrder: Codable, Identifiable, Hashable, Sendable {
    var id: String { token }
    let token: String
    var departmentName: String
    var callNumber: Int
    var createdAt: Date
}

struct SavedReservation: Codable, Identifiable, Hashable, Sendable {
    var id: String { token }
    let token: String
    var reservationNo: String
    var title: String
    var startsAt: Date?
    var savedAt: Date
}

struct SavedCoupon: Codable, Identifiable, Hashable, Sendable {
    var id: String { token }
    let token: String
    var couponNo: String
    var name: String
    var savedAt: Date
}

/// UserDefaults に保存するトークン一覧。
@MainActor
@Observable
final class TokenStore {
    static let shared = TokenStore()

    private(set) var orders: [SavedOrder] = []
    private(set) var reservations: [SavedReservation] = []
    private(set) var coupons: [SavedCoupon] = []

    private let defaults: UserDefaults

    private enum Key {
        static let orders = "gakusai.savedOrders"
        static let reservations = "gakusai.savedReservations"
        static let coupons = "gakusai.savedCoupons"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        orders = Self.load([SavedOrder].self, key: Key.orders, from: defaults)
        reservations = Self.load([SavedReservation].self, key: Key.reservations, from: defaults)
        coupons = Self.load([SavedCoupon].self, key: Key.coupons, from: defaults)
    }

    // MARK: 注文

    func upsert(order: SavedOrder) {
        orders.removeAll { $0.token == order.token }
        orders.insert(order, at: 0)
        if orders.count > 50 { orders.removeLast(orders.count - 50) }
        save(orders, key: Key.orders)
    }

    func removeOrder(token: String) {
        orders.removeAll { $0.token == token }
        save(orders, key: Key.orders)
    }

    // MARK: 予約

    func upsert(reservation: SavedReservation) {
        if let index = reservations.firstIndex(where: { $0.token == reservation.token }) {
            reservations[index] = reservation
        } else {
            reservations.insert(reservation, at: 0)
        }
        save(reservations, key: Key.reservations)
    }

    func removeReservation(token: String) {
        reservations.removeAll { $0.token == token }
        save(reservations, key: Key.reservations)
    }

    // MARK: クーポン

    func upsert(coupon: SavedCoupon) {
        if let index = coupons.firstIndex(where: { $0.token == coupon.token }) {
            coupons[index] = coupon
        } else {
            coupons.insert(coupon, at: 0)
        }
        save(coupons, key: Key.coupons)
    }

    func removeCoupon(token: String) {
        coupons.removeAll { $0.token == token }
        save(coupons, key: Key.coupons)
    }

    // MARK: 永続化

    private func save<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        }
    }

    private static func load<T: Decodable>(_ type: [T].Type, key: String, from defaults: UserDefaults) -> [T] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([T].self, from: data)) ?? []
    }
}
