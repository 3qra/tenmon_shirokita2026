package jp.gakusai.portal.ui.staff

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.Department
import jp.gakusai.portal.data.KitchenItem
import jp.gakusai.portal.data.KitchenOrder
import jp.gakusai.portal.data.KitchenResponse
import jp.gakusai.portal.ui.common.BigButton
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.LastUpdatedBar
import jp.gakusai.portal.ui.common.LoadViewModel
import jp.gakusai.portal.ui.common.LoadingPanel
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.StatusBadge
import jp.gakusai.portal.ui.common.StatusKind
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.cookStatusKind
import jp.gakusai.portal.ui.common.cookStatusLabel
import jp.gakusai.portal.ui.common.errorText
import jp.gakusai.portal.ui.common.formatElapsed
import jp.gakusai.portal.ui.common.rememberNow
import jp.gakusai.portal.ui.common.toUiError
import jp.gakusai.portal.ui.theme.LocalStatusColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class KitchenViewModel(private val api: ApiClient) : LoadViewModel<KitchenResponse?>() {
    private val _departments = MutableStateFlow<List<Department>>(emptyList())
    val departments: StateFlow<List<Department>> = _departments.asStateFlow()

    private val _departmentId = MutableStateFlow<String?>(null)
    val departmentId: StateFlow<String?> = _departmentId.asStateFlow()

    /** 送信中の明細ID（二重タップ防止） */
    private val _sending = MutableStateFlow<Set<String>>(emptySet())
    val sending: StateFlow<Set<String>> = _sending.asStateFlow()

    /** 一時的なお知らせ（409 など） */
    private val _message = MutableStateFlow<UiError?>(null)
    val message: StateFlow<UiError?> = _message.asStateFlow()

    init {
        subscribe(api, "orders")
        poll(20_000L)
        start()
    }

    override suspend fun fetch(): KitchenResponse? {
        if (_departments.value.isEmpty()) {
            val list = api.staffDepartments().sortedBy { it.sortOrder }
            _departments.value = list
            if (_departmentId.value == null) {
                _departmentId.value = (list.firstOrNull { it.kind == "food" } ?: list.firstOrNull())?.id
            }
        }
        val id = _departmentId.value ?: return null
        return api.kitchen(id)
    }

    fun selectDepartment(id: String) {
        if (_departmentId.value == id) return
        _departmentId.value = id
        refresh()
    }

    fun cook(item: KitchenItem, to: String) {
        if (item.id in _sending.value) return
        _sending.update { it + item.id }
        viewModelScope.launch {
            try {
                api.cook(item.id, item.cookStatus, to)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 409（他端末で変更済み・取消済み）も含め、メッセージを出して最新状態を取り直す
                _message.value = e.toUiError()
            } finally {
                _sending.update { it - item.id }
                refresh()
            }
        }
    }

    fun consumeMessage() {
        _message.value = null
    }
}

@Composable
fun KitchenScreen(container: AppContainer, onBack: () -> Unit, onLogin: () -> Unit) {
    StaffGate(container, stringResource(R.string.kitchen_title), onBack, onLogin, allowed = { it.canKitchen }) {
        KitchenContent(container, onBack)
    }
}

@Composable
private fun KitchenContent(container: AppContainer, onBack: () -> Unit) {
    val vm: KitchenViewModel = viewModel { KitchenViewModel(container.api) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val departments by vm.departments.collectAsStateWithLifecycle()
    val departmentId by vm.departmentId.collectAsStateWithLifecycle()
    val sending by vm.sending.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    val messageText = message?.let { errorText(it) }
    LaunchedEffect(message) {
        if (messageText != null) {
            snackbar.showSnackbar(messageText)
            vm.consumeMessage()
        }
    }

    val dept = departments.firstOrNull { it.id == departmentId }
    ScreenScaffold(
        title = stringResource(R.string.kitchen_title) + (dept?.let { " – " + it.name } ?: ""),
        onBack = onBack,
        snackbarHostState = snackbar,
    ) { padding ->
        val now = rememberNow(1_000L)
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                LastUpdatedBar(state.updatedAtMs, live = live, staleAfterMs = 45_000L, onRefresh = vm::refresh)
            }
            if (departments.size > 1) {
                item { DepartmentPicker(departments, departmentId, vm::selectDepartment) }
            }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.updatedAtMs == null && state.loading) item { LoadingPanel() }
            val orders = state.data?.orders.orEmpty()
            if (state.updatedAtMs != null && orders.isEmpty()) {
                item { Text(stringResource(R.string.kitchen_empty), style = MaterialTheme.typography.titleMedium) }
            }
            val fetchedAt = state.updatedAtMs ?: now
            items(orders, key = { it.id }) { o ->
                val elapsed = o.elapsedSec + (now - fetchedAt) / 1000
                KitchenOrderCard(o, elapsed, sending, onCook = vm::cook)
            }
        }
    }
}

@Composable
private fun DepartmentPicker(list: List<Department>, selectedId: String?, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Text(stringResource(R.string.kitchen_department, list.firstOrNull { it.id == selectedId }?.name ?: "—"))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (d in list) {
                DropdownMenuItem(text = { Text(d.name) }, onClick = {
                    onSelect(d.id)
                    open = false
                })
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun KitchenOrderCard(o: KitchenOrder, elapsedSec: Long, sending: Set<String>, onCook: (KitchenItem, String) -> Unit) {
    val c = LocalStatusColors.current
    val cancelled = o.status == "cancelled"
    val border = when {
        cancelled -> BorderStroke(3.dp, c.bad)
        o.longWait -> BorderStroke(3.dp, c.warn)
        else -> null
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        border = border,
        colors = if (cancelled) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant) else CardDefaults.cardColors(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    o.callNumber.toString(),
                    fontSize = 48.sp,
                    lineHeight = 52.sp,
                    fontWeight = FontWeight.Black,
                    textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(R.string.kitchen_elapsed, formatElapsed(elapsedSec)),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = if (o.longWait) FontWeight.Bold else FontWeight.Normal,
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (cancelled) StatusBadge(stringResource(R.string.kitchen_cancelled), StatusKind.Bad)
                if (o.paymentStatus == "unpaid") {
                    StatusBadge(
                        if (o.unpaidWarning) stringResource(R.string.kitchen_unpaid_long) else stringResource(R.string.kitchen_unpaid),
                        StatusKind.Warn,
                    )
                } else {
                    StatusBadge(stringResource(R.string.payment_paid), StatusKind.Ok)
                }
                if (o.longWait && !cancelled) StatusBadge(stringResource(R.string.kitchen_long_wait), StatusKind.Warn)
            }
            for ((i, item) in o.items.withIndex()) {
                if (i > 0) HorizontalDivider()
                KitchenItemRow(item, enabled = !cancelled, busy = item.id in sending, onCook = onCook)
            }
        }
    }
}

@Composable
private fun KitchenItemRow(item: KitchenItem, enabled: Boolean, busy: Boolean, onCook: (KitchenItem, String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.kitchen_item, item.productName, item.quantity),
                    style = MaterialTheme.typography.titleLarge,
                    textDecoration = if (item.cookStatus == "cancelled") TextDecoration.LineThrough else null,
                )
                if (item.optionsLabel.isNotBlank()) Text(item.optionsLabel, style = MaterialTheme.typography.titleMedium)
            }
            StatusBadge(cookStatusLabel(item.cookStatus), cookStatusKind(item.cookStatus))
        }
        if (!enabled) return@Column
        // 遷移は API の cookTransitions と同じ：waiting→cooking/cooked, cooking→cooked/waiting, cooked→cooking
        val actions: List<Pair<String, Boolean>> = when (item.cookStatus) {
            "waiting" -> listOf("cooking" to true, "cooked" to false)
            "cooking" -> listOf("cooked" to true, "waiting" to false)
            "cooked" -> listOf("cooking" to false)
            else -> emptyList()
        }
        if (actions.isEmpty()) return@Column
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((to, primary) in actions) {
                BigButton(
                    text = cookActionLabel(item.cookStatus, to),
                    onClick = { onCook(item, to) },
                    enabled = !busy,
                    loading = busy && primary,
                    outlined = !primary,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun cookActionLabel(from: String, to: String): String = when {
    from == "waiting" && to == "cooking" -> stringResource(R.string.kitchen_action_start)
    to == "cooked" -> stringResource(R.string.kitchen_action_done)
    from == "cooking" && to == "waiting" -> stringResource(R.string.kitchen_action_back_waiting)
    from == "cooked" && to == "cooking" -> stringResource(R.string.kitchen_action_back_cooking)
    else -> to
}
