package jp.gakusai.portal.ui.staff

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.StaffMember
import jp.gakusai.portal.data.StaffSessionStore
import jp.gakusai.portal.ui.common.BigButton
import jp.gakusai.portal.ui.common.CenteredBox
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.SectionCard
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.toUiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class StaffLoginViewModel(private val api: ApiClient, private val session: StaffSessionStore) : ViewModel() {
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _error = MutableStateFlow<UiError?>(null)
    val error: StateFlow<UiError?> = _error.asStateFlow()

    fun login(loginId: String, password: String) {
        if (_busy.value || loginId.isBlank() || password.isEmpty()) return
        _busy.value = true
        _error.value = null
        viewModelScope.launch {
            try {
                val res = api.login(loginId.trim(), password)
                session.save(res.token, res.staff)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e.toUiError()
            } finally {
                _busy.value = false
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            // サーバー側のセッションも無効化する（失敗しても端末からは消す）
            runCatching { api.logout() }
            session.clear()
        }
    }
}

@Composable
fun StaffHomeScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onCheckin: () -> Unit,
    onCoupon: () -> Unit,
    onKitchen: () -> Unit,
    onOpenWeb: () -> Unit,
) {
    val vm: StaffLoginViewModel = viewModel { StaffLoginViewModel(container.api, container.staffSession) }
    val staff by container.staffSession.staff.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.staff_title), onBack = onBack) { padding ->
        val s = staff
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (s == null) {
                LoginForm(vm)
            } else {
                StaffMenu(s, onCheckin, onCoupon, onKitchen, onOpenWeb, onLogout = vm::logout)
            }
        }
    }
}

@Composable
private fun LoginForm(vm: StaffLoginViewModel) {
    val busy by vm.busy.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    var loginId by rememberSaveable { mutableStateOf("") }
    // パスワードは画面回転以外で保存しない
    var password by rememberSaveable { mutableStateOf("") }
    SectionCard {
        Text(stringResource(R.string.login_heading), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(
            value = loginId,
            onValueChange = { loginId = it },
            label = { Text(stringResource(R.string.login_id)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(stringResource(R.string.login_password)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { vm.login(loginId, password) }),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { ErrorPanel(it, onRetry = null) }
        BigButton(
            text = stringResource(R.string.login_submit),
            onClick = { vm.login(loginId, password) },
            enabled = loginId.isNotBlank() && password.isNotEmpty(),
            loading = busy,
            icon = Icons.Filled.Lock,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Text(stringResource(R.string.login_note), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun StaffMenu(
    s: StaffMember,
    onCheckin: () -> Unit,
    onCoupon: () -> Unit,
    onKitchen: () -> Unit,
    onOpenWeb: () -> Unit,
    onLogout: () -> Unit,
) {
    SectionCard {
        Text(stringResource(R.string.staff_logged_in_as, s.name), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.staff_roles, s.roles.joinToString("・") { roleLabel(it) }), style = MaterialTheme.typography.bodyMedium)
    }
    if (s.canCheckin) {
        BigButton(stringResource(R.string.staff_menu_checkin), onCheckin, icon = Icons.Filled.CheckCircle, modifier = Modifier.fillMaxWidth())
    }
    if (s.canVerifyCoupon) {
        BigButton(stringResource(R.string.staff_menu_coupon), onCoupon, icon = Icons.Filled.Search, modifier = Modifier.fillMaxWidth())
    }
    if (s.canKitchen) {
        BigButton(stringResource(R.string.staff_menu_kitchen), onKitchen, icon = Icons.Filled.Build, modifier = Modifier.fillMaxWidth())
    }
    if (!s.canCheckin && !s.canVerifyCoupon && !s.canKitchen) {
        Text(stringResource(R.string.staff_no_app_features))
    }
    BigButton(
        stringResource(R.string.staff_menu_web),
        onOpenWeb,
        icon = Icons.Filled.Share,
        outlined = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Text(stringResource(R.string.staff_web_note), style = MaterialTheme.typography.bodySmall)
    BigButton(
        stringResource(R.string.staff_logout),
        onLogout,
        icon = Icons.AutoMirrored.Filled.ExitToApp,
        outlined = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun roleLabel(role: String): String = when (role) {
    "admin" -> stringResource(R.string.role_admin)
    "cashier" -> stringResource(R.string.role_cashier)
    "kitchen" -> stringResource(R.string.role_kitchen)
    "reception" -> stringResource(R.string.role_reception)
    "treasurer" -> stringResource(R.string.role_treasurer)
    "display" -> stringResource(R.string.role_display)
    "member" -> stringResource(R.string.role_member)
    else -> role
}

/** ログインしていない／権限がないときの案内。 */
@Composable
fun StaffGate(
    container: AppContainer,
    title: String,
    onBack: () -> Unit,
    onLogin: () -> Unit,
    allowed: (StaffMember) -> Boolean,
    content: @Composable (StaffMember) -> Unit,
) {
    val staff by container.staffSession.staff.collectAsStateWithLifecycle()
    val s = staff
    if (s != null && allowed(s)) {
        content(s)
        return
    }
    ScreenScaffold(title = title, onBack = onBack) { padding ->
        CenteredBox(padding) {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    if (s == null) stringResource(R.string.staff_need_login) else stringResource(R.string.staff_no_permission),
                    style = MaterialTheme.typography.titleMedium,
                )
                if (s == null) {
                    BigButton(stringResource(R.string.login_submit), onLogin, icon = Icons.Filled.Lock, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
