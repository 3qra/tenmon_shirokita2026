package jp.gakusai.portal.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Go API（api/internal/app/*.go）のJSONと一致させる。キーは snake_case。
// サーバーが null を返しうる項目は nullable、それ以外も既定値を持たせて項目追加・欠落に耐える。

// ---------------------------------------------------------------- 共通

/** {"error":{"code","message"}} */
@Serializable
data class ErrorEnvelope(val error: ErrorBody? = null)

@Serializable
data class ErrorBody(
    val code: String = "",
    val message: String = "",
)

// ---------------------------------------------------------------- 部門・商品

/** departments.go Department */
@Serializable
data class Department(
    val id: String,
    val code: String = "",
    val name: String = "",
    val kind: String = "",
    /** before / open / paused / closed */
    @SerialName("business_status") val businessStatus: String = "",
    @SerialName("mobile_order_enabled") val mobileOrderEnabled: Boolean = false,
    @SerialName("site_code_enabled") val siteCodeEnabled: Boolean = false,
    @SerialName("site_code_interval_sec") val siteCodeIntervalSec: Int = 0,
    @SerialName("site_code_grace_sec") val siteCodeGraceSec: Int = 0,
    val notice: String = "",
    @SerialName("sort_order") val sortOrder: Int = 0,
)

/** products.go catalog: option_groups[].values[] */
@Serializable
data class OptionValue(
    val id: String,
    val name: String = "",
    @SerialName("sort_order") val sortOrder: Int = 0,
    val active: Boolean = true,
)

@Serializable
data class OptionGroup(
    val id: String,
    val name: String = "",
    @SerialName("sort_order") val sortOrder: Int = 0,
    val active: Boolean = true,
    val values: List<OptionValue> = emptyList(),
)

@Serializable
data class Variant(
    val id: String,
    val price: Int = 0,
    val visibility: String = "",
    /** on_sale / sold_out / stopped */
    @SerialName("sale_status") val saleStatus: String = "",
    val active: Boolean = true,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("option_value_ids") val optionValueIds: List<String> = emptyList(),
    val label: String = "",
)

@Serializable
data class Product(
    val id: String,
    @SerialName("department_id") val departmentId: String = "",
    val name: String = "",
    val description: String = "",
    @SerialName("needs_cooking") val needsCooking: Boolean = false,
    val visibility: String = "",
    val active: Boolean = true,
    @SerialName("sort_order") val sortOrder: Int = 0,
    @SerialName("option_groups") val optionGroups: List<OptionGroup> = emptyList(),
    val variants: List<Variant> = emptyList(),
)

/** GET /public/departments/{id}/products */
@Serializable
data class CatalogResponse(
    val department: Department,
    val products: List<Product> = emptyList(),
)

// ---------------------------------------------------------------- 注文

@Serializable
data class OrderItemRequest(
    @SerialName("variant_id") val variantId: String,
    val quantity: Int,
)

/** POST /public/orders/quote */
@Serializable
data class QuoteRequest(
    @SerialName("department_id") val departmentId: String,
    val items: List<OrderItemRequest>,
)

@Serializable
data class QuotedOption(
    val group: String = "",
    val value: String = "",
    @SerialName("value_id") val valueId: String = "",
)

/** orders.go pricedItem */
@Serializable
data class QuotedItem(
    @SerialName("variant_id") val variantId: String,
    @SerialName("product_id") val productId: String = "",
    @SerialName("product_name") val productName: String = "",
    @SerialName("options_label") val optionsLabel: String = "",
    val options: List<QuotedOption> = emptyList(),
    @SerialName("unit_price") val unitPrice: Int = 0,
    val quantity: Int = 0,
    @SerialName("line_total") val lineTotal: Int = 0,
    @SerialName("needs_cooking") val needsCooking: Boolean = false,
)

@Serializable
data class QuoteResponse(
    val items: List<QuotedItem> = emptyList(),
    val subtotal: Int = 0,
)

/** POST /public/orders {department_id, items, site_code, channel} */
@Serializable
data class CreateOrderRequest(
    @SerialName("department_id") val departmentId: String,
    val items: List<OrderItemRequest>,
    /** 3桁の現地コード。先頭の0を保つため文字列で送る。不要なら省略。 */
    @SerialName("site_code") val siteCode: String? = null,
    val channel: String = "android",
)

@Serializable
data class CreateOrderResponse(
    val id: String,
    @SerialName("call_number") val callNumber: Int = 0,
    val total: Int = 0,
    @SerialName("access_token") val accessToken: String,
    @SerialName("status_url") val statusUrl: String = "",
)

@Serializable
data class OrderItem(
    val id: String,
    @SerialName("product_name") val productName: String = "",
    @SerialName("options_label") val optionsLabel: String = "",
    @SerialName("unit_price") val unitPrice: Int = 0,
    val quantity: Int = 0,
    @SerialName("line_total") val lineTotal: Int = 0,
    val discount: Int = 0,
    @SerialName("needs_cooking") val needsCooking: Boolean = false,
    /** waiting / cooking / cooked / cancelled / not_required */
    @SerialName("cook_status") val cookStatus: String = "",
    @SerialName("variant_id") val variantId: String? = null,
    @SerialName("product_id") val productId: String? = null,
)

@Serializable
data class OrderCoupon(
    val id: String,
    @SerialName("coupon_no") val couponNo: String = "",
    val name: String? = null,
    val persons: Int = 0,
    val discount: Int = 0,
    val status: String = "",
    @SerialName("forfeited_persons") val forfeitedPersons: Int = 0,
)

/** orders.go orderJSON（来場者向け） */
@Serializable
data class PublicOrder(
    val id: String,
    @SerialName("department_id") val departmentId: String = "",
    @SerialName("department_name") val departmentName: String = "",
    @SerialName("business_day") val businessDay: String = "",
    @SerialName("call_number") val callNumber: Int = 0,
    val channel: String = "",
    /** accepted / cancelled / completed */
    val status: String = "",
    /** unpaid / paid / partially_refunded / refunded */
    @SerialName("payment_status") val paymentStatus: String = "",
    /** pending / handed */
    @SerialName("handoff_status") val handoffStatus: String = "",
    val subtotal: Int = 0,
    val discount: Int = 0,
    val total: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("handed_at") val handedAt: String? = null,
    val items: List<OrderItem> = emptyList(),
    val coupons: List<OrderCoupon> = emptyList(),
    val ready: Boolean = false,
) {
    /** 来場者が自分で取消できる条件（最終判断はAPI）。 */
    val visitorCancellable: Boolean
        get() = status == "accepted" && paymentStatus == "unpaid" &&
            items.none { it.cookStatus == "cooking" || it.cookStatus == "cooked" }
}

// ---------------------------------------------------------------- プラネタリウム

/** GET /public/screenings の要素 */
@Serializable
data class PublicScreening(
    val id: String,
    val title: String = "",
    @SerialName("business_day") val businessDay: String = "",
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("ends_at") val endsAt: String = "",
    /** ○ / △ / × */
    val symbol: String = "",
    @SerialName("status_text") val statusText: String = "",
    @SerialName("advance_open") val advanceOpen: Boolean = false,
    @SerialName("advance_available") val advanceAvailable: Boolean = false,
    @SerialName("walkin_available") val walkinAvailable: Boolean = false,
    /** scheduled / running / finished / cancelled */
    @SerialName("run_status") val runStatus: String = "",
)

@Serializable
data class PublicScreeningsResponse(
    val screenings: List<PublicScreening> = emptyList(),
    @SerialName("server_time") val serverTime: String = "",
)

/** GET /public/screenings/{id} */
@Serializable
data class PublicScreeningDetail(
    val id: String,
    val title: String = "",
    @SerialName("business_day") val businessDay: String = "",
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("ends_at") val endsAt: String = "",
    val symbol: String = "",
    @SerialName("status_text") val statusText: String = "",
    @SerialName("advance_open") val advanceOpen: Boolean = false,
    @SerialName("advance_available") val advanceAvailable: Boolean = false,
    @SerialName("walkin_available") val walkinAvailable: Boolean = false,
    @SerialName("max_party_size") val maxPartySize: Int = 0,
    @SerialName("run_status") val runStatus: String = "",
)

/** POST /public/reservations */
@Serializable
data class CreateReservationRequest(
    @SerialName("screening_id") val screeningId: String,
    val name: String,
    @SerialName("party_size") val partySize: Int,
)

@Serializable
data class CreateReservationResponse(
    val id: String,
    @SerialName("reservation_no") val reservationNo: String = "",
    @SerialName("access_token") val accessToken: String,
    val url: String = "",
)

@Serializable
data class ReservationScreening(
    val id: String,
    val title: String = "",
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("ends_at") val endsAt: String = "",
    @SerialName("run_status") val runStatus: String = "",
    @SerialName("business_day") val businessDay: String = "",
    @SerialName("cancel_reason") val cancelReason: String? = null,
)

@Serializable
data class Ticket(
    val id: String,
    val seq: Int = 0,
    @SerialName("ticket_no") val ticketNo: String = "",
    /** valid / void */
    val status: String = "",
    @SerialName("admitted_at") val admittedAt: String? = null,
    /** QRに表示する入場用トークン */
    @SerialName("entry_token") val entryToken: String? = null,
)

@Serializable
data class ReservationCoupon(
    val id: String,
    @SerialName("coupon_no") val couponNo: String = "",
    val name: String? = null,
    @SerialName("persons_total") val personsTotal: Int = 0,
    @SerialName("persons_remaining") val personsRemaining: Int = 0,
    val status: String = "",
    @SerialName("valid_until") val validUntil: String? = null,
    val token: String? = null,
)

/** planetarium.go reservationDetail + wallet_enabled */
@Serializable
data class ReservationDetail(
    val id: String,
    @SerialName("reservation_no") val reservationNo: String = "",
    val kind: String = "",
    val name: String = "",
    @SerialName("party_size") val partySize: Int = 0,
    /** confirmed / cancelled_self / cancelled_staff / cancelled_screening */
    val status: String = "",
    @SerialName("cancel_reason") val cancelReason: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    val screening: ReservationScreening,
    val tickets: List<Ticket> = emptyList(),
    val coupons: List<ReservationCoupon> = emptyList(),
    @SerialName("wallet_enabled") val walletEnabled: Boolean = false,
) {
    val visitorCancellable: Boolean
        get() = status == "confirmed" && screening.runStatus == "scheduled" &&
            tickets.none { it.admittedAt != null }
}

// ---------------------------------------------------------------- クーポン

/** GET /public/coupons/by-token/{token} */
@Serializable
data class PublicCoupon(
    val id: String,
    @SerialName("coupon_no") val couponNo: String = "",
    val name: String? = null,
    val description: String? = null,
    val conditions: JsonObject? = null,
    @SerialName("persons_total") val personsTotal: Int = 0,
    @SerialName("persons_remaining") val personsRemaining: Int = 0,
    /** active / used / revoked */
    val status: String = "",
    @SerialName("valid_from") val validFrom: String? = null,
    @SerialName("valid_until") val validUntil: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    val summary: String = "",
    val token: String = "",
)

/** GET /staff/coupons/verify/{token}（読むだけ。消費はしない） */
@Serializable
data class CouponVerifyResponse(
    val id: String,
    @SerialName("coupon_no") val couponNo: String = "",
    val status: String = "",
    @SerialName("persons_total") val personsTotal: Int = 0,
    @SerialName("persons_remaining") val personsRemaining: Int = 0,
    val conditions: CouponConditions? = null,
    val usable: Boolean = false,
    val summary: String = "",
    val reason: String? = null,
)

/** coupons.go couponSnapshot（表示に使う項目のみ） */
@Serializable
data class CouponConditions(
    val name: String = "",
    val description: String = "",
    @SerialName("discount_type") val discountType: String = "",
    @SerialName("discount_value") val discountValue: Int = 0,
    val scope: String = "",
    @SerialName("holder_mode") val holderMode: String = "",
    val splittable: Boolean = false,
    val combinable: Boolean = false,
    @SerialName("valid_from") val validFrom: String? = null,
    @SerialName("valid_until") val validUntil: String? = null,
)

// ---------------------------------------------------------------- スタッフ

@Serializable
data class LoginRequest(
    @SerialName("login_id") val loginId: String,
    val password: String,
)

/** middleware.go Staff */
@Serializable
data class StaffMember(
    val id: String,
    val name: String = "",
    @SerialName("login_id") val loginId: String = "",
    val roles: List<String> = emptyList(),
) {
    fun has(vararg r: String) = roles.any { it in r }
    val canCheckin get() = has("reception", "admin")
    val canVerifyCoupon get() = has("cashier", "treasurer", "admin")
    val canKitchen get() = has("kitchen", "cashier", "admin")
}

@Serializable
data class LoginResponse(
    val token: String,
    @SerialName("expires_at") val expiresAt: String = "",
    val staff: StaffMember,
)

/** GET /staff/screenings の要素（使う項目のみ） */
@Serializable
data class StaffScreening(
    val id: String,
    val title: String = "",
    @SerialName("business_day") val businessDay: String = "",
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("ends_at") val endsAt: String = "",
    val capacity: Int = 0,
    val taken: Int = 0,
    @SerialName("admitted_count") val admittedCount: Int = 0,
    @SerialName("run_status") val runStatus: String = "",
    @SerialName("status_text") val statusText: String = "",
)

@Serializable
data class StaffScreeningsResponse(
    val screenings: List<StaffScreening> = emptyList(),
    @SerialName("server_time") val serverTime: String = "",
)

/** POST /staff/checkin/verify, /staff/checkin {token | ticket_no, screening_id} */
@Serializable
data class CheckinRequest(
    val token: String? = null,
    @SerialName("ticket_no") val ticketNo: String? = null,
    @SerialName("screening_id") val screeningId: String? = null,
)

@Serializable
data class CheckinTicket(
    val id: String = "",
    @SerialName("ticket_no") val ticketNo: String = "",
    val seq: Int = 0,
    val status: String = "",
    @SerialName("reservation_status") val reservationStatus: String = "",
    @SerialName("reservation_no") val reservationNo: String = "",
    val name: String = "",
    @SerialName("party_size") val partySize: Int = 0,
    @SerialName("screening_id") val screeningId: String = "",
    val title: String = "",
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("run_status") val runStatus: String = "",
    @SerialName("admitted_at") val admittedAt: String? = null,
)

/**
 * result: ok（verifyのみ：入場可能）/ admitted / already_admitted / cancelled / wrong_screening /
 * screening_cancelled / finished / not_found
 */
@Serializable
data class CheckinResult(
    val result: String,
    val message: String = "",
    val ticket: CheckinTicket? = null,
)

/** GET /staff/kitchen */
@Serializable
data class KitchenResponse(
    val orders: List<KitchenOrder> = emptyList(),
    @SerialName("server_time") val serverTime: String = "",
)

@Serializable
data class KitchenOrder(
    val id: String,
    @SerialName("call_number") val callNumber: Int = 0,
    @SerialName("payment_status") val paymentStatus: String = "",
    val status: String = "",
    val channel: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("elapsed_sec") val elapsedSec: Int = 0,
    @SerialName("long_wait") val longWait: Boolean = false,
    @SerialName("unpaid_warning") val unpaidWarning: Boolean = false,
    val items: List<KitchenItem> = emptyList(),
)

@Serializable
data class KitchenItem(
    val id: String,
    @SerialName("product_name") val productName: String = "",
    @SerialName("options_label") val optionsLabel: String = "",
    val quantity: Int = 0,
    @SerialName("cook_status") val cookStatus: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
)

/** POST /staff/order-items/{id}/cook {from, to} */
@Serializable
data class CookRequest(
    val from: String,
    val to: String,
)

@Serializable
data class CookResponse(
    val ok: Boolean = false,
    @SerialName("cook_status") val cookStatus: String = "",
)

@Serializable
data class OkResponse(val ok: Boolean = false)
