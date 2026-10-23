package jp.gakusai.portal.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import jp.gakusai.portal.R

// APIの状態コードを利用者向けの日本語ラベルへ変換する。

@Composable
fun businessStatusLabel(s: String): String = when (s) {
    "before" -> stringResource(R.string.business_before)
    "open" -> stringResource(R.string.business_open)
    "paused" -> stringResource(R.string.business_paused)
    "closed" -> stringResource(R.string.business_closed)
    else -> s
}

@Composable
fun saleStatusLabel(s: String): String = when (s) {
    "on_sale" -> stringResource(R.string.sale_on_sale)
    "sold_out" -> stringResource(R.string.sale_sold_out)
    "stopped" -> stringResource(R.string.sale_stopped)
    else -> s
}

@Composable
fun orderStatusLabel(s: String): String = when (s) {
    "accepted" -> stringResource(R.string.order_status_accepted)
    "cancelled" -> stringResource(R.string.order_status_cancelled)
    "completed" -> stringResource(R.string.order_status_completed)
    else -> s
}

@Composable
fun paymentStatusLabel(s: String): String = when (s) {
    "unpaid" -> stringResource(R.string.payment_unpaid)
    "paid" -> stringResource(R.string.payment_paid)
    "partially_refunded" -> stringResource(R.string.payment_partially_refunded)
    "refunded" -> stringResource(R.string.payment_refunded)
    else -> s
}

@Composable
fun cookStatusLabel(s: String): String = when (s) {
    "waiting" -> stringResource(R.string.cook_waiting)
    "cooking" -> stringResource(R.string.cook_cooking)
    "cooked" -> stringResource(R.string.cook_cooked)
    "cancelled" -> stringResource(R.string.cook_cancelled)
    "not_required" -> stringResource(R.string.cook_not_required)
    else -> s
}

fun cookStatusKind(s: String): StatusKind = when (s) {
    "waiting" -> StatusKind.Neutral
    "cooking" -> StatusKind.Warn
    "cooked", "not_required" -> StatusKind.Ok
    "cancelled" -> StatusKind.Bad
    else -> StatusKind.Neutral
}

@Composable
fun runStatusLabel(s: String): String = when (s) {
    "scheduled" -> stringResource(R.string.run_scheduled)
    "running" -> stringResource(R.string.run_running)
    "finished" -> stringResource(R.string.run_finished)
    "cancelled" -> stringResource(R.string.run_cancelled)
    else -> s
}

@Composable
fun reservationStatusLabel(s: String): String = when (s) {
    "confirmed" -> stringResource(R.string.reservation_confirmed)
    "cancelled_self" -> stringResource(R.string.reservation_cancelled_self)
    "cancelled_staff" -> stringResource(R.string.reservation_cancelled_staff)
    "cancelled_screening" -> stringResource(R.string.reservation_cancelled_screening)
    else -> s
}

@Composable
fun couponStatusLabel(s: String): String = when (s) {
    "active" -> stringResource(R.string.coupon_status_active)
    "used" -> stringResource(R.string.coupon_status_used)
    "revoked" -> stringResource(R.string.coupon_status_revoked)
    else -> s
}

/** ○△× を文字でも説明する。 */
@Composable
fun seatSymbolLabel(symbol: String): String = when (symbol) {
    "○" -> stringResource(R.string.seat_available)
    "△" -> stringResource(R.string.seat_few)
    "×" -> stringResource(R.string.seat_full)
    else -> symbol
}

fun seatSymbolKind(symbol: String): StatusKind = when (symbol) {
    "○" -> StatusKind.Ok
    "△" -> StatusKind.Warn
    "×" -> StatusKind.Bad
    else -> StatusKind.Neutral
}
