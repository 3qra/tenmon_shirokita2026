package jp.gakusai.portal.ui.staff

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.CheckinRequest
import jp.gakusai.portal.data.CheckinResult
import jp.gakusai.portal.data.IdempotencyKey
import jp.gakusai.portal.data.StaffScreening
import jp.gakusai.portal.ui.common.BigButton
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.SectionCard
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.formatDateTime
import jp.gakusai.portal.ui.common.formatTime
import jp.gakusai.portal.ui.common.toUiError
import jp.gakusai.portal.ui.theme.LocalStatusColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class CheckinViewModel(private val api: ApiClient) : ViewModel() {
    sealed interface Phase {
        data object Scanning : Phase
        data class Busy(val confirming: Boolean) : Phase

        /** verify の結果（入場はまだ確定していない） */
        data class Verified(val result: CheckinResult, val input: CheckinRequest) : Phase

        /** checkin の結果（確定済み、または拒否） */
        data class Done(val result: CheckinResult) : Phase
        data class Failed(val error: UiError, val input: CheckinRequest, val confirming: Boolean) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Scanning)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private val _screenings = MutableStateFlow<List<StaffScreening>>(emptyList())
    val screenings: StateFlow<List<StaffScreening>> = _screenings.asStateFlow()

    /** 指定すると別の上映回のチケットを wrong_screening として判定する（任意） */
    private val _screeningId = MutableStateFlow<String?>(null)
    val screeningId: StateFlow<String?> = _screeningId.asStateFlow()

    private val _autoConfirm = MutableStateFlow(false)
    val autoConfirm: StateFlow<Boolean> = _autoConfirm.asStateFlow()

    private val idempotency = IdempotencyKey()

    init {
        loadScreenings()
    }

    fun loadScreenings() {
        viewModelScope.launch {
            runCatching { api.staffScreenings() }.onSuccess { r -> _screenings.value = r.screenings }
        }
    }

    fun selectScreening(id: String?) {
        _screeningId.value = id
    }

    fun setAutoConfirm(v: Boolean) {
        _autoConfirm.value = v
    }

    fun onScanned(raw: String) {
        if (_phase.value != Phase.Scanning) return
        verify(CheckinRequest(token = extractToken(raw), screeningId = _screeningId.value))
    }

    fun onManual(ticketNo: String) {
        val no = ticketNo.trim()
        if (no.isEmpty() || _phase.value is Phase.Busy) return
        verify(CheckinRequest(ticketNo = no, screeningId = _screeningId.value))
    }

    fun verify(input: CheckinRequest) {
        _phase.value = Phase.Busy(confirming = false)
        viewModelScope.launch {
            try {
                val r = api.checkinVerify(input)
                if (r.result == "ok" && _autoConfirm.value) {
                    confirmInternal(input)
                } else {
                    _phase.value = Phase.Verified(r, input)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _phase.value = Phase.Failed(e.toUiError(), input, confirming = false)
            }
        }
    }

    fun confirm(input: CheckinRequest) {
        if (_phase.value is Phase.Busy) return
        viewModelScope.launch { confirmInternal(input) }
    }

    private suspend fun confirmInternal(input: CheckinRequest) {
        _phase.value = Phase.Busy(confirming = true)
        // 同じチケットの再送（通信失敗時）は同じキーを使う
        val key = idempotency.obtain(api.json.encodeToString(CheckinRequest.serializer(), input))
        try {
            val r = api.checkin(input, key)
            idempotency.settle(null)
            _phase.value = Phase.Done(r)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            idempotency.settle(e)
            _phase.value = Phase.Failed(e.toUiError(), input, confirming = true)
        }
    }

    fun retry() {
        val p = _phase.value as? Phase.Failed ?: return
        if (p.confirming) confirm(p.input) else verify(p.input)
    }

    fun next() {
        _phase.value = Phase.Scanning
    }
}

@Composable
fun CheckinScreen(container: AppContainer, onBack: () -> Unit, onLogin: () -> Unit) {
    StaffGate(container, stringResource(R.string.checkin_title), onBack, onLogin, allowed = { it.canCheckin }) {
        CheckinContent(container, onBack)
    }
}

@Composable
private fun CheckinContent(container: AppContainer, onBack: () -> Unit) {
    val vm: CheckinViewModel = viewModel { CheckinViewModel(container.api) }
    val phase by vm.phase.collectAsStateWithLifecycle()
    val screenings by vm.screenings.collectAsStateWithLifecycle()
    val screeningId by vm.screeningId.collectAsStateWithLifecycle()
    val autoConfirm by vm.autoConfirm.collectAsStateWithLifecycle()
    val permission = rememberCameraPermission()
    val context = LocalContext.current
    var manual by rememberSaveable { mutableStateOf("") }

    ScreenScaffold(title = stringResource(R.string.checkin_title), onBack = onBack) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ScreeningPicker(screenings, screeningId, vm::selectScreening)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.checkin_auto_confirm), modifier = Modifier.weight(1f))
                Switch(checked = autoConfirm, onCheckedChange = vm::setAutoConfirm)
            }

            when (val p = phase) {
                CheckinViewModel.Phase.Scanning -> {
                    if (permission.granted) {
                        Text(stringResource(R.string.checkin_scan_help), style = MaterialTheme.typography.titleMedium)
                        QrScanner(
                            enabled = true,
                            onScanned = vm::onScanned,
                            modifier = Modifier.fillMaxWidth().aspectRatio(1f),
                        )
                    } else {
                        CameraPermissionPanel(
                            denied = permission.denied,
                            onRequest = permission.request,
                            onOpenSettings = { openAppSettings(context) },
                        )
                    }
                }
                is CheckinViewModel.Phase.Busy -> {
                    BigButton(
                        text = if (p.confirming) stringResource(R.string.checkin_confirming) else stringResource(R.string.checkin_verifying),
                        onClick = {},
                        loading = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                is CheckinViewModel.Phase.Verified -> {
                    CheckinResultPanel(p.result, verifyOnly = true)
                    if (p.result.result == "ok") {
                        BigButton(
                            text = stringResource(R.string.checkin_confirm),
                            onClick = { vm.confirm(p.input) },
                            icon = Icons.Filled.CheckCircle,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
                        )
                    }
                    BigButton(stringResource(R.string.checkin_next), vm::next, outlined = true, modifier = Modifier.fillMaxWidth())
                }
                is CheckinViewModel.Phase.Done -> {
                    CheckinResultPanel(p.result, verifyOnly = false)
                    BigButton(stringResource(R.string.checkin_next), vm::next, modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp))
                }
                is CheckinViewModel.Phase.Failed -> {
                    ErrorPanel(p.error, onRetry = vm::retry)
                    BigButton(stringResource(R.string.checkin_next), vm::next, outlined = true, modifier = Modifier.fillMaxWidth())
                }
            }

            // カメラが使えないとき・QRが読めないときの手入力（チケット番号 例：17-003-1）
            SectionCard {
                Text(stringResource(R.string.checkin_manual_heading), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = manual,
                    onValueChange = { manual = it.take(40) },
                    label = { Text(stringResource(R.string.checkin_manual_label)) },
                    placeholder = { Text(stringResource(R.string.checkin_manual_placeholder)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { vm.onManual(manual) }),
                    modifier = Modifier.fillMaxWidth(),
                )
                BigButton(
                    text = stringResource(R.string.checkin_manual_submit),
                    onClick = { vm.onManual(manual) },
                    enabled = manual.isNotBlank() && phase !is CheckinViewModel.Phase.Busy,
                    icon = Icons.Filled.Search,
                    outlined = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun ScreeningPicker(list: List<StaffScreening>, selectedId: String?, onSelect: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val selected = list.firstOrNull { it.id == selectedId }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            Text(
                if (selected == null) stringResource(R.string.checkin_screening_any)
                else stringResource(R.string.checkin_screening_selected, formatTime(selected.startsAt), selected.title),
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.checkin_screening_any)) },
                onClick = {
                    onSelect(null)
                    open = false
                },
            )
            for (s in list.filter { it.runStatus != "finished" && it.runStatus != "cancelled" }) {
                DropdownMenuItem(
                    text = {
                        Text(stringResource(R.string.checkin_screening_option, formatTime(s.startsAt), s.title, s.admittedCount, s.taken))
                    },
                    onClick = {
                        onSelect(s.id)
                        open = false
                    },
                )
            }
        }
    }
}

@Composable
fun CameraPermissionPanel(denied: Boolean, onRequest: () -> Unit, onOpenSettings: () -> Unit) {
    SectionCard {
        Text(stringResource(R.string.camera_permission_title), style = MaterialTheme.typography.titleMedium)
        Text(
            if (denied) stringResource(R.string.camera_permission_denied) else stringResource(R.string.camera_permission_body),
        )
        BigButton(stringResource(R.string.camera_permission_request), onRequest, modifier = Modifier.fillMaxWidth())
        if (denied) {
            BigButton(
                stringResource(R.string.camera_permission_settings),
                onOpenSettings,
                icon = Icons.Filled.Settings,
                outlined = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** 結果を大きく表示する（色＋アイコン＋文字）。 */
@Composable
private fun CheckinResultPanel(r: CheckinResult, verifyOnly: Boolean) {
    val c = LocalStatusColors.current
    data class Look(val bg: Color, val fg: Color, val icon: ImageVector, val headline: String)
    val look = when (r.result) {
        "admitted" -> Look(c.ok, c.onOk, Icons.Filled.CheckCircle, stringResource(R.string.checkin_result_admitted))
        "ok" -> Look(c.ok, c.onOk, Icons.Filled.CheckCircle, stringResource(R.string.checkin_result_ok))
        "already_admitted" -> Look(c.warn, c.onWarn, Icons.Filled.Warning, stringResource(R.string.checkin_result_already))
        "cancelled" -> Look(c.bad, c.onBad, Icons.Filled.Close, stringResource(R.string.checkin_result_cancelled))
        "wrong_screening" -> Look(c.bad, c.onBad, Icons.Filled.Close, stringResource(R.string.checkin_result_wrong))
        "screening_cancelled" -> Look(c.bad, c.onBad, Icons.Filled.Close, stringResource(R.string.checkin_result_screening_cancelled))
        "finished" -> Look(c.bad, c.onBad, Icons.Filled.Close, stringResource(R.string.checkin_result_finished))
        "not_found" -> Look(c.bad, c.onBad, Icons.Filled.Close, stringResource(R.string.checkin_result_not_found))
        else -> Look(c.neutral, c.onNeutral, Icons.Filled.Warning, r.result)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(look.bg, RoundedCornerShape(16.dp))
            .padding(20.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(look.icon, contentDescription = null, tint = look.fg, modifier = Modifier.size(96.dp))
        Text(look.headline, color = look.fg, fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.Black, textAlign = TextAlign.Center)
        if (r.message.isNotBlank()) {
            Text(r.message, color = look.fg, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        }
        if (verifyOnly && r.result == "ok") {
            Text(stringResource(R.string.checkin_not_yet_confirmed), color = look.fg, fontWeight = FontWeight.Bold)
        }
        r.ticket?.let { t ->
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.checkin_ticket_no, t.ticketNo), color = look.fg, style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.checkin_ticket_screening, formatTime(t.startsAt), t.title), color = look.fg)
            Text(stringResource(R.string.checkin_ticket_reservation, t.reservationNo, t.name, t.partySize), color = look.fg)
            t.admittedAt?.let { Text(stringResource(R.string.checkin_ticket_admitted_at, formatDateTime(it)), color = look.fg) }
        }
    }
}
