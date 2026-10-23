package jp.gakusai.portal.ui.visitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.CreateReservationRequest
import jp.gakusai.portal.data.IdempotencyKey
import jp.gakusai.portal.data.PublicScreening
import jp.gakusai.portal.data.PublicScreeningDetail
import jp.gakusai.portal.data.PublicScreeningsResponse
import jp.gakusai.portal.data.ReservationDetail
import jp.gakusai.portal.data.SavedItem
import jp.gakusai.portal.data.SavedItemsStore
import jp.gakusai.portal.data.Ticket
import jp.gakusai.portal.ui.common.BigButton
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
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.couponStatusLabel
import jp.gakusai.portal.ui.common.formatDateTime
import jp.gakusai.portal.ui.common.formatDay
import jp.gakusai.portal.ui.common.formatTime
import jp.gakusai.portal.ui.common.reservationStatusLabel
import jp.gakusai.portal.ui.common.runStatusLabel
import jp.gakusai.portal.ui.common.seatSymbolKind
import jp.gakusai.portal.ui.common.seatSymbolLabel
import jp.gakusai.portal.ui.common.toUiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ================================================================ 上映一覧

class ScreeningsViewModel(private val api: ApiClient) : LoadViewModel<PublicScreeningsResponse>() {
    init {
        subscribe(api, "screenings")
        poll(60_000L)
        start()
    }

    override suspend fun fetch(): PublicScreeningsResponse = api.screenings()
}

@Composable
fun ScreeningsScreen(container: AppContainer, onBack: () -> Unit, onSelect: (String) -> Unit) {
    val vm: ScreeningsViewModel = viewModel { ScreeningsViewModel(container.api) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.planetarium_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, onRefresh = vm::refresh) }
            item { Text(stringResource(R.string.planetarium_legend), style = MaterialTheme.typography.bodySmall) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.data == null && state.loading) item { LoadingPanel() }
            val list = state.data?.screenings.orEmpty()
            if (state.data != null && list.isEmpty()) item { Text(stringResource(R.string.planetarium_empty)) }
            list.groupBy { it.businessDay }.forEach { (day, rows) ->
                item(key = "day-$day") {
                    Text(
                        formatDay(day),
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.padding(top = 8.dp).semantics { heading() },
                    )
                }
                items(rows, key = { it.id }) { s -> ScreeningRow(s, onClick = { onSelect(s.id) }) }
            }
        }
    }
}

@Composable
private fun ScreeningRow(s: PublicScreening, onClick: () -> Unit) {
    val dimmed = s.runStatus == "finished" || s.runStatus == "cancelled"
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
        colors = if (dimmed) CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant) else CardDefaults.cardColors(),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    stringResource(R.string.time_range, formatTime(s.startsAt), formatTime(s.endsAt)),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    textDecoration = if (s.runStatus == "cancelled") TextDecoration.LineThrough else null,
                )
                Text(s.title, style = MaterialTheme.typography.bodyLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ScreeningStatusBadges(s.symbol, s.statusText, s.runStatus)
                }
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
        }
    }
}

/** 中止・終了・受付停止などは文字で、空席は記号＋文字で示す。 */
@Composable
private fun ScreeningStatusBadges(symbol: String, statusText: String, runStatus: String) {
    when {
        runStatus == "cancelled" -> StatusBadge(statusText.ifBlank { runStatusLabel(runStatus) }, StatusKind.Bad)
        runStatus == "finished" -> StatusBadge(statusText.ifBlank { runStatusLabel(runStatus) }, StatusKind.Neutral)
        statusText.isNotBlank() -> {
            StatusBadge(statusText, StatusKind.Neutral)
            StatusBadge("$symbol ${seatSymbolLabel(symbol)}", seatSymbolKind(symbol), icon = null)
        }
        else -> StatusBadge("$symbol ${seatSymbolLabel(symbol)}", seatSymbolKind(symbol), icon = null)
    }
}

// ================================================================ 上映詳細・予約フォーム

class ScreeningDetailViewModel(
    private val api: ApiClient,
    private val saved: SavedItemsStore,
    private val screeningId: String,
) : LoadViewModel<PublicScreeningDetail>() {
    data class Form(
        val name: String = "",
        val partySize: Int = 1,
        val submitting: Boolean = false,
        val error: UiError? = null,
        val createdToken: String? = null,
    )

    private val _form = MutableStateFlow(Form())
    val form: StateFlow<Form> = _form.asStateFlow()
    private val idempotency = IdempotencyKey()

    init {
        subscribe(api, "screenings")
        start()
    }

    override suspend fun fetch(): PublicScreeningDetail = api.screening(screeningId)

    override fun onLoaded(data: PublicScreeningDetail) {
        val max = data.maxPartySize.coerceAtLeast(1)
        _form.update { it.copy(partySize = it.partySize.coerceIn(1, max)) }
    }

    fun setName(v: String) = _form.update { it.copy(name = v.take(30), error = null) }
    fun setPartySize(v: Int) = _form.update { it.copy(partySize = v, error = null) }

    fun submit() {
        val f = _form.value
        val s = state.value.data ?: return
        if (f.submitting || f.name.isBlank()) return
        val req = CreateReservationRequest(screeningId = screeningId, name = f.name.trim(), partySize = f.partySize)
        val key = idempotency.obtain(api.json.encodeToString(CreateReservationRequest.serializer(), req))
        _form.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            try {
                val res = api.createReservation(req, key)
                idempotency.settle(null)
                saved.upsert(
                    SavedItem(
                        kind = "reservation",
                        token = res.accessToken,
                        title = s.title,
                        subtitle = formatDateTime(s.startsAt),
                    ),
                )
                _form.update { it.copy(submitting = false, createdToken = res.accessToken) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                idempotency.settle(e)
                _form.update { it.copy(submitting = false, error = e.toUiError()) }
                refresh()
            }
        }
    }

    fun consumeCreated() = _form.update { it.copy(createdToken = null) }
}

@Composable
fun ScreeningDetailScreen(container: AppContainer, screeningId: String, onBack: () -> Unit, onReserved: (String) -> Unit) {
    val vm: ScreeningDetailViewModel = viewModel { ScreeningDetailViewModel(container.api, container.savedItems, screeningId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val form by vm.form.collectAsStateWithLifecycle()

    LaunchedEffect(form.createdToken) {
        form.createdToken?.let {
            vm.consumeCreated()
            onReserved(it)
        }
    }

    ScreenScaffold(title = stringResource(R.string.screening_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.data == null && state.loading) item { LoadingPanel() }
            val s = state.data ?: return@LazyColumn
            item {
                SectionCard {
                    Text(s.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(
                        stringResource(R.string.screening_when, formatDay(s.businessDay), formatTime(s.startsAt), formatTime(s.endsAt)),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ScreeningStatusBadges(s.symbol, s.statusText, s.runStatus)
                    }
                    Text(
                        if (s.walkinAvailable) stringResource(R.string.screening_walkin_yes) else stringResource(R.string.screening_walkin_no),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            val canReserve = s.advanceOpen && s.advanceAvailable && s.maxPartySize > 0
            if (!canReserve) {
                item {
                    SectionCard {
                        Text(stringResource(R.string.screening_cannot_reserve), style = MaterialTheme.typography.titleMedium)
                        if (s.statusText.isNotBlank()) Text(s.statusText)
                    }
                }
                return@LazyColumn
            }
            item {
                SectionCard {
                    Text(stringResource(R.string.reserve_heading), style = MaterialTheme.typography.titleLarge)
                    OutlinedTextField(
                        value = form.name,
                        onValueChange = vm::setName,
                        label = { Text(stringResource(R.string.reserve_name)) },
                        supportingText = { Text(stringResource(R.string.reserve_name_help)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(stringResource(R.string.reserve_party), style = MaterialTheme.typography.titleSmall)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QuantityStepper(form.partySize, vm::setPartySize, min = 1, max = s.maxPartySize)
                        Spacer(Modifier.width(12.dp))
                        Text(stringResource(R.string.reserve_party_max, s.maxPartySize), style = MaterialTheme.typography.bodySmall)
                    }
                    Text(stringResource(R.string.reserve_note), style = MaterialTheme.typography.bodySmall)
                }
            }
            form.error?.let { e -> item { ErrorPanel(e, onRetry = if (e is UiError.Network) vm::submit else null) } }
            item {
                BigButton(
                    text = if (form.error is UiError.Network) stringResource(R.string.reserve_submit_retry) else stringResource(R.string.reserve_submit),
                    onClick = vm::submit,
                    enabled = form.name.isNotBlank(),
                    loading = form.submitting,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

// ================================================================ 予約確認・チケット

class ReservationViewModel(
    private val api: ApiClient,
    private val saved: SavedItemsStore,
    private val token: String,
) : LoadViewModel<ReservationDetail>() {
    private val _cancelling = MutableStateFlow(false)
    val cancelling: StateFlow<Boolean> = _cancelling.asStateFlow()
    private val _actionError = MutableStateFlow<UiError?>(null)
    val actionError: StateFlow<UiError?> = _actionError.asStateFlow()

    init {
        subscribe(api, "screenings")
        poll(60_000L)
        start()
    }

    override suspend fun fetch(): ReservationDetail = api.reservation(token)

    override fun onLoaded(data: ReservationDetail) {
        saved.upsert(
            SavedItem(
                kind = "reservation",
                token = token,
                title = data.screening.title,
                subtitle = formatDateTime(data.screening.startsAt),
            ),
        )
        // 予約に紐づいて発券されたクーポンもマイチケットに保存する
        for (c in data.coupons) {
            val t = c.token ?: continue
            saved.upsert(SavedItem(kind = "coupon", token = t, title = c.name ?: c.couponNo, subtitle = c.couponNo))
        }
    }

    fun cancel() {
        if (_cancelling.value) return
        _cancelling.value = true
        _actionError.value = null
        viewModelScope.launch {
            try {
                replaceData(api.cancelReservation(token))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _actionError.value = e.toUiError()
                refresh()
            } finally {
                _cancelling.value = false
            }
        }
    }
}

@Composable
fun ReservationScreen(container: AppContainer, token: String, onBack: () -> Unit, onOpenCoupon: (String) -> Unit) {
    val vm: ReservationViewModel = viewModel { ReservationViewModel(container.api, container.savedItems, token) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val cancelling by vm.cancelling.collectAsStateWithLifecycle()
    val actionError by vm.actionError.collectAsStateWithLifecycle()
    var confirm by rememberSaveable { mutableStateOf(false) }

    val r = state.data
    val showQr = r != null && r.status == "confirmed" && r.screening.runStatus != "cancelled" &&
        r.tickets.any { it.isUsable() }
    if (showQr) KeepScreenBright()

    ScreenScaffold(title = stringResource(R.string.reservation_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (r == null) {
                if (state.loading) item { LoadingPanel() }
                return@LazyColumn
            }
            if (r.screening.runStatus == "cancelled") {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            StatusBadge(stringResource(R.string.run_cancelled), StatusKind.Bad)
                            Text(stringResource(R.string.reservation_screening_cancelled), style = MaterialTheme.typography.titleMedium)
                            r.screening.cancelReason?.takeIf { it.isNotBlank() }?.let {
                                Text(stringResource(R.string.reservation_cancel_reason, it))
                            }
                        }
                    }
                }
            }
            item {
                SectionCard {
                    Text(r.screening.title, style = MaterialTheme.typography.headlineSmall)
                    Text(
                        stringResource(
                            R.string.screening_when,
                            formatDay(r.screening.businessDay),
                            formatTime(r.screening.startsAt),
                            formatTime(r.screening.endsAt),
                        ),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        StatusBadge(
                            reservationStatusLabel(r.status),
                            if (r.status == "confirmed") StatusKind.Ok else StatusKind.Bad,
                        )
                        if (r.screening.runStatus != "scheduled" && r.screening.runStatus != "cancelled") {
                            StatusBadge(runStatusLabel(r.screening.runStatus), StatusKind.Neutral)
                        }
                    }
                    Text(stringResource(R.string.reservation_no, r.reservationNo), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.reservation_name_party, r.name, r.partySize))
                    if (r.status != "confirmed") {
                        r.cancelReason?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.reservation_cancel_reason, it)) }
                    }
                }
            }
            if (showQr) {
                item { Text(stringResource(R.string.reservation_qr_help), style = MaterialTheme.typography.bodyMedium) }
            }
            items(r.tickets, key = { it.id }) { t ->
                TicketCard(t, reservationActive = r.status == "confirmed" && r.screening.runStatus != "cancelled")
            }
            if (r.coupons.isNotEmpty()) {
                item { Text(stringResource(R.string.reservation_coupons), style = MaterialTheme.typography.titleMedium) }
                items(r.coupons, key = { "c-" + it.id }) { c ->
                    Card(
                        onClick = { c.token?.let(onOpenCoupon) },
                        enabled = c.token != null,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
                    ) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(c.name ?: c.couponNo, style = MaterialTheme.typography.titleMedium)
                                Text(stringResource(R.string.coupon_remaining, c.personsRemaining, c.personsTotal))
                            }
                            StatusBadge(couponStatusLabel(c.status), if (c.status == "active") StatusKind.Ok else StatusKind.Neutral)
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                        }
                    }
                }
            }
            actionError?.let { e -> item { ErrorPanel(e, onRetry = null) } }
            if (r.visitorCancellable) {
                item {
                    BigButton(
                        text = stringResource(R.string.reservation_cancel),
                        onClick = { confirm = true },
                        loading = cancelling,
                        outlined = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            item { Text(stringResource(R.string.reservation_keep_link), style = MaterialTheme.typography.bodySmall) }
        }
    }
    if (confirm) {
        ConfirmDialog(
            title = stringResource(R.string.reservation_cancel_confirm_title),
            message = stringResource(R.string.reservation_cancel_confirm_message),
            confirmText = stringResource(R.string.reservation_cancel),
            onConfirm = {
                confirm = false
                vm.cancel()
            },
            onDismiss = { confirm = false },
        )
    }
}

private fun Ticket.isUsable() = status == "valid" && admittedAt == null && !entryToken.isNullOrBlank()

@Composable
private fun TicketCard(t: Ticket, reservationActive: Boolean) {
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.ticket_label, t.seq, t.ticketNo),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            when {
                t.admittedAt != null -> StatusBadge(stringResource(R.string.ticket_admitted), StatusKind.Ok)
                t.status == "void" || !reservationActive -> StatusBadge(stringResource(R.string.ticket_void), StatusKind.Bad)
                else -> StatusBadge(stringResource(R.string.ticket_valid), StatusKind.Info)
            }
        }
        if (t.admittedAt != null) {
            Text(stringResource(R.string.ticket_admitted_at, formatDateTime(t.admittedAt)))
        } else if (reservationActive && t.isUsable()) {
            QrCode(
                content = t.entryToken!!,
                description = stringResource(R.string.ticket_qr_description, t.ticketNo),
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Text(
                stringResource(R.string.ticket_number_fallback, t.ticketNo),
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
