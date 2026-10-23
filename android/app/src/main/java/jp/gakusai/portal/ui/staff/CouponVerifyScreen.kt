package jp.gakusai.portal.ui.staff

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import jp.gakusai.portal.data.CouponVerifyResponse
import jp.gakusai.portal.ui.common.BigButton
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.SectionCard
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.couponStatusLabel
import jp.gakusai.portal.ui.common.formatDateTime
import jp.gakusai.portal.ui.common.toUiError
import jp.gakusai.portal.ui.theme.LocalStatusColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** クーポンを読み取って条件・残人数を確認する。読むだけで消費はしない（消費は会計確定時）。 */
class CouponVerifyViewModel(private val api: ApiClient) : ViewModel() {
    sealed interface Phase {
        data object Scanning : Phase
        data object Busy : Phase
        data class Result(val coupon: CouponVerifyResponse) : Phase
        data class Failed(val error: UiError, val token: String) : Phase
    }

    private val _phase = MutableStateFlow<Phase>(Phase.Scanning)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    fun onScanned(raw: String) {
        if (_phase.value != Phase.Scanning) return
        verify(raw)
    }

    fun verify(raw: String) {
        // QRはURL形式（…/c/<token>）でもよい。サーバー側でも末尾のtokenを取り出す。
        val token = extractToken(raw)
        if (token.isEmpty()) return
        _phase.value = Phase.Busy
        viewModelScope.launch {
            try {
                _phase.value = Phase.Result(api.verifyCoupon(token))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _phase.value = Phase.Failed(e.toUiError(), token)
            }
        }
    }

    fun retry() {
        (_phase.value as? Phase.Failed)?.let { verify(it.token) }
    }

    fun next() {
        _phase.value = Phase.Scanning
    }
}

@Composable
fun CouponVerifyScreen(container: AppContainer, onBack: () -> Unit, onLogin: () -> Unit) {
    StaffGate(container, stringResource(R.string.coupon_verify_title), onBack, onLogin, allowed = { it.canVerifyCoupon }) {
        CouponVerifyContent(container, onBack)
    }
}

@Composable
private fun CouponVerifyContent(container: AppContainer, onBack: () -> Unit) {
    val vm: CouponVerifyViewModel = viewModel { CouponVerifyViewModel(container.api) }
    val phase by vm.phase.collectAsStateWithLifecycle()
    val permission = rememberCameraPermission()
    val context = LocalContext.current
    var manual by rememberSaveable { mutableStateOf("") }

    ScreenScaffold(title = stringResource(R.string.coupon_verify_title), onBack = onBack) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.coupon_verify_note), style = MaterialTheme.typography.bodyMedium)
            when (val p = phase) {
                CouponVerifyViewModel.Phase.Scanning -> {
                    if (permission.granted) {
                        QrScanner(enabled = true, onScanned = vm::onScanned, modifier = Modifier.fillMaxWidth().aspectRatio(1f))
                    } else {
                        CameraPermissionPanel(permission.denied, permission.request) { openAppSettings(context) }
                    }
                }
                CouponVerifyViewModel.Phase.Busy -> BigButton(
                    stringResource(R.string.coupon_verify_busy), {}, loading = true, modifier = Modifier.fillMaxWidth(),
                )
                is CouponVerifyViewModel.Phase.Result -> {
                    CouponResultPanel(p.coupon)
                    BigButton(stringResource(R.string.checkin_next), vm::next, modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp))
                }
                is CouponVerifyViewModel.Phase.Failed -> {
                    ErrorPanel(p.error, onRetry = vm::retry)
                    BigButton(stringResource(R.string.checkin_next), vm::next, outlined = true, modifier = Modifier.fillMaxWidth())
                }
            }
            SectionCard {
                Text(stringResource(R.string.coupon_verify_manual_heading), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = manual,
                    onValueChange = { manual = it.trim().take(300) },
                    label = { Text(stringResource(R.string.coupon_verify_manual_label)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { vm.verify(manual) }),
                    modifier = Modifier.fillMaxWidth(),
                )
                BigButton(
                    stringResource(R.string.coupon_verify_manual_submit),
                    { vm.verify(manual) },
                    enabled = manual.isNotBlank() && phase != CouponVerifyViewModel.Phase.Busy,
                    icon = Icons.Filled.Search,
                    outlined = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun CouponResultPanel(c: CouponVerifyResponse) {
    val s = LocalStatusColors.current
    val bg = if (c.usable) s.ok else s.bad
    val fg = if (c.usable) s.onOk else s.onBad
    Column(
        Modifier
            .fillMaxWidth()
            .background(bg, RoundedCornerShape(16.dp))
            .padding(20.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (c.usable) Icons.Filled.CheckCircle else Icons.Filled.Close, contentDescription = null, tint = fg, modifier = Modifier.size(88.dp))
        Text(
            if (c.usable) stringResource(R.string.coupon_verify_usable) else stringResource(R.string.coupon_verify_not_usable),
            color = fg, fontSize = 36.sp, lineHeight = 40.sp, fontWeight = FontWeight.Black, textAlign = TextAlign.Center,
        )
        c.reason?.takeIf { it.isNotBlank() }?.let { Text(it, color = fg, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center) }
        val name = c.conditions?.name.orEmpty()
        if (name.isNotBlank()) Text(name, color = fg, style = MaterialTheme.typography.titleLarge)
        if (c.summary.isNotBlank()) Text(c.summary, color = fg, textAlign = TextAlign.Center)
        Text(
            stringResource(R.string.coupon_remaining, c.personsRemaining, c.personsTotal),
            color = fg, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold,
        )
        Text(stringResource(R.string.coupon_verify_status, couponStatusLabel(c.status)), color = fg)
        c.conditions?.validUntil?.let { Text(stringResource(R.string.coupon_valid_until, formatDateTime(it)), color = fg) }
        c.conditions?.let { cond ->
            if (!cond.splittable && c.usable) Text(stringResource(R.string.coupon_verify_not_splittable), color = fg, textAlign = TextAlign.Center)
        }
        Text(stringResource(R.string.coupon_no, c.couponNo), color = fg, style = MaterialTheme.typography.bodySmall)
    }
}
