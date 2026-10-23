package jp.gakusai.portal.ui.visitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.PublicCoupon
import jp.gakusai.portal.data.SavedItem
import jp.gakusai.portal.data.SavedItemsStore
import jp.gakusai.portal.ui.common.ConfirmDialog
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.KeepScreenBright
import jp.gakusai.portal.ui.common.LastUpdatedBar
import jp.gakusai.portal.ui.common.LoadViewModel
import jp.gakusai.portal.ui.common.LoadingPanel
import jp.gakusai.portal.ui.common.QrCode
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.SectionCard
import jp.gakusai.portal.ui.common.StatusBadge
import jp.gakusai.portal.ui.common.StatusKind
import jp.gakusai.portal.ui.common.couponStatusLabel
import jp.gakusai.portal.ui.common.formatDateTime

// ================================================================ クーポン表示

class CouponViewModel(
    private val api: ApiClient,
    private val saved: SavedItemsStore,
    private val token: String,
) : LoadViewModel<PublicCoupon>() {
    init {
        poll(60_000L)
        start()
    }

    override suspend fun fetch(): PublicCoupon = api.coupon(token)

    override fun onLoaded(data: PublicCoupon) {
        saved.upsert(SavedItem(kind = "coupon", token = token, title = data.name ?: data.couponNo, subtitle = data.couponNo))
    }
}

@Composable
fun CouponScreen(container: AppContainer, token: String, onBack: () -> Unit) {
    val vm: CouponViewModel = viewModel { CouponViewModel(container.api, container.savedItems, token) }
    val state by vm.state.collectAsStateWithLifecycle()
    val c = state.data
    val usable = c != null && c.status == "active" && c.personsRemaining > 0
    if (usable) KeepScreenBright()

    ScreenScaffold(title = stringResource(R.string.coupon_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, staleAfterMs = 120_000L, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (c == null) {
                if (state.loading) item { LoadingPanel() }
                return@LazyColumn
            }
            item {
                SectionCard {
                    Text(c.name ?: c.couponNo, style = MaterialTheme.typography.headlineSmall)
                    StatusBadge(
                        couponStatusLabel(c.status),
                        when {
                            usable -> StatusKind.Ok
                            c.status == "revoked" -> StatusKind.Bad
                            else -> StatusKind.Neutral
                        },
                    )
                    if (c.summary.isNotBlank()) Text(c.summary, style = MaterialTheme.typography.titleMedium)
                    c.description?.takeIf { it.isNotBlank() }?.let { Text(it) }
                    Text(
                        stringResource(R.string.coupon_remaining, c.personsRemaining, c.personsTotal),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                    )
                    c.validUntil?.let { Text(stringResource(R.string.coupon_valid_until, formatDateTime(it))) }
                    Text(stringResource(R.string.coupon_no, c.couponNo), style = MaterialTheme.typography.bodySmall)
                }
            }
            if (usable) {
                item {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        QrCode(content = c.token.ifBlank { token }, description = stringResource(R.string.coupon_qr_description))
                        Text(
                            stringResource(R.string.coupon_qr_help),
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
            } else {
                item { Text(stringResource(R.string.coupon_not_usable)) }
            }
        }
    }
}

// ================================================================ マイチケット

@Composable
fun MyTicketsScreen(container: AppContainer, onBack: () -> Unit, onOpen: (SavedItem) -> Unit) {
    val items by container.savedItems.items.collectAsStateWithLifecycle()
    var deleting by remember { mutableStateOf<SavedItem?>(null) }

    ScreenScaffold(title = stringResource(R.string.mine_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { Text(stringResource(R.string.mine_help), style = MaterialTheme.typography.bodyMedium) }
            if (items.isEmpty()) {
                item { Text(stringResource(R.string.mine_empty), style = MaterialTheme.typography.titleMedium) }
            }
            for ((kind, heading) in listOf(
                "order" to R.string.mine_orders,
                "reservation" to R.string.mine_reservations,
                "coupon" to R.string.mine_coupons,
            )) {
                val group = items.filter { it.kind == kind }
                if (group.isEmpty()) continue
                item(key = "h-$kind") {
                    Text(stringResource(heading), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
                }
                items(group, key = { it.kind + it.token }) { s ->
                    Card(onClick = { onOpen(s) }, modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp)) {
                        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(s.title, style = MaterialTheme.typography.titleMedium)
                                val sub = when (s.kind) {
                                    "order" -> stringResource(R.string.mine_order_sub, s.subtitle)
                                    else -> s.subtitle
                                }
                                if (sub.isNotBlank()) Text(sub, style = MaterialTheme.typography.bodyMedium)
                            }
                            IconButton(onClick = { deleting = s }, modifier = Modifier.size(56.dp)) {
                                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.mine_delete))
                            }
                        }
                    }
                }
            }
        }
    }
    deleting?.let { d ->
        ConfirmDialog(
            title = stringResource(R.string.mine_delete_title),
            message = stringResource(R.string.mine_delete_message),
            confirmText = stringResource(R.string.mine_delete),
            onConfirm = {
                container.savedItems.remove(d.kind, d.token)
                deleting = null
            },
            onDismiss = { deleting = null },
        )
    }
}
