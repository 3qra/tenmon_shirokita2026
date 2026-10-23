package jp.gakusai.portal.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalUriHandler
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.ui.staff.CheckinScreen
import jp.gakusai.portal.ui.staff.CouponVerifyScreen
import jp.gakusai.portal.ui.staff.KitchenScreen
import jp.gakusai.portal.ui.staff.StaffHomeScreen
import jp.gakusai.portal.ui.visitor.CheckoutScreen
import jp.gakusai.portal.ui.visitor.CouponScreen
import jp.gakusai.portal.ui.visitor.DepartmentsScreen
import jp.gakusai.portal.ui.visitor.HomeScreen
import jp.gakusai.portal.ui.visitor.MenuScreen
import jp.gakusai.portal.ui.visitor.MyTicketsScreen
import jp.gakusai.portal.ui.visitor.OrderStatusScreen
import jp.gakusai.portal.ui.visitor.ReservationScreen
import jp.gakusai.portal.ui.visitor.ScreeningDetailScreen
import jp.gakusai.portal.ui.visitor.ScreeningsScreen

object Routes {
    const val HOME = "home"
    const val DEPARTMENTS = "order"
    const val MENU = "order/{deptId}"
    const val CHECKOUT = "order/{deptId}/checkout"
    const val ORDER_STATUS = "o/{token}"
    const val SCREENINGS = "planetarium"
    const val SCREENING = "planetarium/{id}"
    const val RESERVATION = "r/{token}"
    const val COUPON = "c/{token}"
    const val MY_TICKETS = "mine"
    const val STAFF_HOME = "staff"
    const val STAFF_CHECKIN = "staff/checkin"
    const val STAFF_COUPON = "staff/coupon"
    const val STAFF_KITCHEN = "staff/kitchen"

    fun menu(deptId: String) = "order/$deptId"
    fun checkout(deptId: String) = "order/$deptId/checkout"
    fun orderStatus(token: String) = "o/$token"
    fun screening(id: String) = "planetarium/$id"
    fun reservation(token: String) = "r/$token"
    fun coupon(token: String) = "c/$token"
}

@Composable
fun AppNavHost(
    container: AppContainer,
    pendingRoute: String?,
    onPendingRouteHandled: () -> Unit,
    nav: NavHostController = rememberNavController(),
) {
    val uriHandler = LocalUriHandler.current

    LaunchedEffect(pendingRoute) {
        if (pendingRoute != null) {
            nav.navigate(pendingRoute) { launchSingleTop = true }
            onPendingRouteHandled()
        }
    }
    // スタッフのセッションが切れたらスタッフ画面（ログイン）へ戻す
    LaunchedEffect(Unit) {
        container.api.unauthorized.collect {
            nav.navigate(Routes.STAFF_HOME) {
                popUpTo(Routes.HOME)
                launchSingleTop = true
            }
        }
    }

    val back: () -> Unit = { if (!nav.popBackStack()) nav.navigate(Routes.HOME) }

    NavHost(navController = nav, startDestination = Routes.HOME) {
        composable(Routes.HOME) {
            HomeScreen(
                container = container,
                onOrder = { nav.navigate(Routes.DEPARTMENTS) },
                onPlanetarium = { nav.navigate(Routes.SCREENINGS) },
                onMyTickets = { nav.navigate(Routes.MY_TICKETS) },
                onStaff = { nav.navigate(Routes.STAFF_HOME) },
            )
        }
        composable(Routes.DEPARTMENTS) {
            DepartmentsScreen(container, onBack = back, onSelect = { nav.navigate(Routes.menu(it)) })
        }
        composable(Routes.MENU) { entry ->
            val deptId = entry.arguments?.getString("deptId").orEmpty()
            MenuScreen(container, deptId, onBack = back, onCheckout = { nav.navigate(Routes.checkout(deptId)) })
        }
        composable(Routes.CHECKOUT) { entry ->
            val deptId = entry.arguments?.getString("deptId").orEmpty()
            CheckoutScreen(
                container, deptId, onBack = back,
                onOrdered = { token ->
                    nav.navigate(Routes.orderStatus(token)) {
                        popUpTo(Routes.HOME)
                    }
                },
            )
        }
        composable(Routes.ORDER_STATUS) { entry ->
            OrderStatusScreen(container, entry.arguments?.getString("token").orEmpty(), onBack = back)
        }
        composable(Routes.SCREENINGS) {
            ScreeningsScreen(container, onBack = back, onSelect = { nav.navigate(Routes.screening(it)) })
        }
        composable(Routes.SCREENING) { entry ->
            ScreeningDetailScreen(
                container, entry.arguments?.getString("id").orEmpty(), onBack = back,
                onReserved = { token ->
                    nav.navigate(Routes.reservation(token)) {
                        popUpTo(Routes.SCREENINGS)
                    }
                },
            )
        }
        composable(Routes.RESERVATION) { entry ->
            ReservationScreen(
                container, entry.arguments?.getString("token").orEmpty(), onBack = back,
                onOpenCoupon = { nav.navigate(Routes.coupon(it)) },
            )
        }
        composable(Routes.COUPON) { entry ->
            CouponScreen(container, entry.arguments?.getString("token").orEmpty(), onBack = back)
        }
        composable(Routes.MY_TICKETS) {
            MyTicketsScreen(
                container, onBack = back,
                onOpen = { item ->
                    when (item.kind) {
                        "order" -> nav.navigate(Routes.orderStatus(item.token))
                        "reservation" -> nav.navigate(Routes.reservation(item.token))
                        "coupon" -> nav.navigate(Routes.coupon(item.token))
                    }
                },
            )
        }
        composable(Routes.STAFF_HOME) {
            StaffHomeScreen(
                container, onBack = back,
                onCheckin = { nav.navigate(Routes.STAFF_CHECKIN) },
                onCoupon = { nav.navigate(Routes.STAFF_COUPON) },
                onKitchen = { nav.navigate(Routes.STAFF_KITCHEN) },
                onOpenWeb = { runCatching { uriHandler.openUri(container.webBaseUrl + "/staff") } },
            )
        }
        composable(Routes.STAFF_CHECKIN) {
            CheckinScreen(container, onBack = back, onLogin = { nav.navigate(Routes.STAFF_HOME) })
        }
        composable(Routes.STAFF_COUPON) {
            CouponVerifyScreen(container, onBack = back, onLogin = { nav.navigate(Routes.STAFF_HOME) })
        }
        composable(Routes.STAFF_KITCHEN) {
            KitchenScreen(container, onBack = back, onLogin = { nav.navigate(Routes.STAFF_HOME) })
        }
    }
}
