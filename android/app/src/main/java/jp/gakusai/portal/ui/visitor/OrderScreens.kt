package jp.gakusai.portal.ui.visitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.CartLine
import jp.gakusai.portal.data.CartStore
import jp.gakusai.portal.data.CatalogResponse
import jp.gakusai.portal.data.CreateOrderRequest
import jp.gakusai.portal.data.Department
import jp.gakusai.portal.data.IdempotencyKey
import jp.gakusai.portal.data.OrderItemRequest
import jp.gakusai.portal.data.Product
import jp.gakusai.portal.data.PublicOrder
import jp.gakusai.portal.data.QuoteRequest
import jp.gakusai.portal.data.QuoteResponse
import jp.gakusai.portal.data.SavedItem
import jp.gakusai.portal.data.SavedItemsStore
import jp.gakusai.portal.data.Variant
import jp.gakusai.portal.ui.common.BigButton
import jp.gakusai.portal.ui.common.ConfirmDialog
import jp.gakusai.portal.ui.common.ErrorPanel
import jp.gakusai.portal.ui.common.LastUpdatedBar
import jp.gakusai.portal.ui.common.LoadViewModel
import jp.gakusai.portal.ui.common.LoadingPanel
import jp.gakusai.portal.ui.common.ScreenScaffold
import jp.gakusai.portal.ui.common.SectionCard
import jp.gakusai.portal.ui.common.StatusBadge
import jp.gakusai.portal.ui.common.StatusKind
import jp.gakusai.portal.ui.common.UiError
import jp.gakusai.portal.ui.common.businessStatusLabel
import jp.gakusai.portal.ui.common.cookStatusKind
import jp.gakusai.portal.ui.common.cookStatusLabel
import jp.gakusai.portal.ui.common.formatDateTime
import jp.gakusai.portal.ui.common.formatYen
import jp.gakusai.portal.ui.common.orderStatusLabel
import jp.gakusai.portal.ui.common.paymentStatusLabel
import jp.gakusai.portal.ui.common.saleStatusLabel
import jp.gakusai.portal.ui.common.toUiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 注文を受け付けられる部門か（最終判断はAPI）。 */
private val Department.acceptsMobileOrder: Boolean get() = businessStatus == "open" && mobileOrderEnabled

// ================================================================ 部門一覧

class DepartmentsViewModel(private val api: ApiClient) : LoadViewModel<List<Department>>() {
    init {
        subscribe(api, "departments")
        start()
    }

    override suspend fun fetch(): List<Department> = api.departments().sortedBy { it.sortOrder }
}

@Composable
fun DepartmentsScreen(container: AppContainer, onBack: () -> Unit, onSelect: (String) -> Unit) {
    val vm: DepartmentsViewModel = viewModel { DepartmentsViewModel(container.api) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.order_departments_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.data == null && state.loading) item { LoadingPanel() }
            val list = state.data.orEmpty()
            if (state.data != null && list.isEmpty()) item { Text(stringResource(R.string.order_departments_empty)) }
            items(list, key = { it.id }) { d ->
                Card(onClick = { onSelect(d.id) }, modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(d.name, style = MaterialTheme.typography.titleLarge)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                StatusBadge(businessStatusLabel(d.businessStatus), if (d.businessStatus == "open") StatusKind.Ok else StatusKind.Neutral)
                                if (d.acceptsMobileOrder) {
                                    StatusBadge(stringResource(R.string.order_mobile_on), StatusKind.Info)
                                } else {
                                    StatusBadge(stringResource(R.string.order_mobile_off), StatusKind.Neutral)
                                }
                            }
                            if (d.notice.isNotBlank()) Text(d.notice, style = MaterialTheme.typography.bodyMedium)
                        }
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                    }
                }
            }
        }
    }
}

// ================================================================ 商品一覧・カート追加

class MenuViewModel(
    private val api: ApiClient,
    private val cart: CartStore,
    private val departmentId: String,
) : LoadViewModel<CatalogResponse>() {
    /** 商品ID → (選択肢グループID → 値ID) */
    private val _selections = MutableStateFlow<Map<String, Map<String, String>>>(emptyMap())
    val selections: StateFlow<Map<String, Map<String, String>>> = _selections.asStateFlow()

    private val _quantities = MutableStateFlow<Map<String, Int>>(emptyMap())
    val quantities: StateFlow<Map<String, Int>> = _quantities.asStateFlow()

    val carts = cart.carts

    init {
        subscribe(api, "products,departments")
        start()
    }

    override suspend fun fetch(): CatalogResponse = api.catalog(departmentId)

    override fun onLoaded(data: CatalogResponse) {
        // 初期選択：販売中のバリエーションの組み合わせ（なければ最初のもの）
        _selections.update { current ->
            val next = current.toMutableMap()
            for (p in data.products) {
                if (p.optionGroups.isEmpty() || next.containsKey(p.id)) continue
                val v = p.variants.firstOrNull { it.saleStatus == "on_sale" } ?: p.variants.firstOrNull() ?: continue
                val sel = mutableMapOf<String, String>()
                for (g in p.optionGroups) g.values.firstOrNull { it.id in v.optionValueIds }?.let { sel[g.id] = it.id }
                next[p.id] = sel
            }
            next
        }
    }

    fun select(productId: String, groupId: String, valueId: String) {
        _selections.update { it + (productId to (it[productId].orEmpty() + (groupId to valueId))) }
    }

    fun setQuantity(productId: String, q: Int) {
        _quantities.update { it + (productId to q.coerceIn(1, CartStore.MAX_QTY)) }
    }

    fun resolveVariant(p: Product, selection: Map<String, String>): Variant? {
        if (p.optionGroups.isEmpty()) return p.variants.firstOrNull { it.optionValueIds.isEmpty() } ?: p.variants.singleOrNull()
        if (p.optionGroups.any { it.id !in selection }) return null
        val wanted = p.optionGroups.mapNotNull { selection[it.id] }.toSet()
        return p.variants.firstOrNull { it.optionValueIds.toSet() == wanted }
    }

    fun addToCart(p: Product, v: Variant, quantity: Int) {
        cart.add(
            departmentId,
            CartLine(variantId = v.id, productName = p.name, optionsLabel = v.label, unitPrice = v.price, quantity = quantity),
        )
        _quantities.update { it - p.id }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MenuScreen(container: AppContainer, departmentId: String, onBack: () -> Unit, onCheckout: () -> Unit) {
    val vm: MenuViewModel = viewModel { MenuViewModel(container.api, container.cart, departmentId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val selections by vm.selections.collectAsStateWithLifecycle()
    val quantities by vm.quantities.collectAsStateWithLifecycle()
    val carts by vm.carts.collectAsStateWithLifecycle()
    val lines = carts[departmentId].orEmpty()
    val dept = state.data?.department

    ScreenScaffold(
        title = dept?.name ?: stringResource(R.string.order_menu_title),
        onBack = onBack,
        bottomBar = {
            if (lines.isNotEmpty()) {
                Surface(tonalElevation = 6.dp) {
                    BigButton(
                        text = stringResource(R.string.order_cart_button, lines.sumOf { it.quantity }, formatYen(lines.sumOf { it.unitPrice * it.quantity })),
                        onClick = onCheckout,
                        icon = Icons.Filled.ShoppingCart,
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp),
                    )
                }
            }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.data == null && state.loading) item { LoadingPanel() }
            if (dept != null) {
                if (!dept.acceptsMobileOrder) {
                    item {
                        SectionCard {
                            StatusBadge(businessStatusLabel(dept.businessStatus), StatusKind.Warn)
                            Text(stringResource(R.string.order_not_accepting))
                        }
                    }
                }
                if (dept.notice.isNotBlank()) item { SectionCard { Text(dept.notice) } }
                if (dept.siteCodeEnabled) {
                    item { Text(stringResource(R.string.order_site_code_hint_menu), style = MaterialTheme.typography.bodyMedium) }
                }
            }
            val products = state.data?.products.orEmpty()
            if (state.data != null && products.isEmpty()) item { Text(stringResource(R.string.order_menu_empty)) }
            items(products, key = { it.id }) { p ->
                val sel = selections[p.id].orEmpty()
                val variant = vm.resolveVariant(p, sel)
                val qty = quantities[p.id] ?: 1
                ProductCard(
                    product = p,
                    selection = sel,
                    variant = variant,
                    quantity = qty,
                    orderingEnabled = dept?.acceptsMobileOrder == true,
                    onSelect = { g, v -> vm.select(p.id, g, v) },
                    onQuantity = { vm.setQuantity(p.id, it) },
                    onAdd = { if (variant != null) vm.addToCart(p, variant, qty) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProductCard(
    product: Product,
    selection: Map<String, String>,
    variant: Variant?,
    quantity: Int,
    orderingEnabled: Boolean,
    onSelect: (groupId: String, valueId: String) -> Unit,
    onQuantity: (Int) -> Unit,
    onAdd: () -> Unit,
) {
    SectionCard {
        Text(product.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        if (product.description.isNotBlank()) Text(product.description, style = MaterialTheme.typography.bodyMedium)
        for (g in product.optionGroups) {
            Text(g.name, style = MaterialTheme.typography.titleSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (v in g.values) {
                    val selected = selection[g.id] == v.id
                    FilterChip(
                        selected = selected,
                        onClick = { onSelect(g.id, v.id) },
                        label = { Text(v.name, style = MaterialTheme.typography.titleMedium) },
                        leadingIcon = if (selected) {
                            { Icon(Icons.Filled.Check, contentDescription = null) }
                        } else {
                            null
                        },
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
        }
        HorizontalDivider()
        if (variant == null) {
            Text(stringResource(R.string.order_variant_unavailable), color = MaterialTheme.colorScheme.error)
            return@SectionCard
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(formatYen(variant.price), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            val onSale = variant.saleStatus == "on_sale"
            StatusBadge(saleStatusLabel(variant.saleStatus), if (onSale) StatusKind.Ok else StatusKind.Bad)
        }
        if (variant.saleStatus == "on_sale" && orderingEnabled) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                QuantityStepper(quantity, onQuantity, min = 1)
                BigButton(
                    text = stringResource(R.string.order_add_to_cart),
                    onClick = onAdd,
                    icon = Icons.Filled.Add,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** − 数量 ＋（各ボタン48dp以上）。 */
@Composable
fun QuantityStepper(value: Int, onChange: (Int) -> Unit, min: Int = 0, max: Int = CartStore.MAX_QTY) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        FilledTonalIconButton(onClick = { onChange(value - 1) }, enabled = value > min, modifier = Modifier.size(52.dp)) {
            Text("−", style = MaterialTheme.typography.titleLarge)
        }
        Text(
            stringResource(R.string.quantity_value, value),
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
            modifier = Modifier.width(56.dp),
        )
        FilledTonalIconButton(onClick = { onChange(value + 1) }, enabled = value < max, modifier = Modifier.size(52.dp)) {
            Text("＋", style = MaterialTheme.typography.titleLarge)
        }
    }
}

// ================================================================ カート確認・現地コード・注文確定

class CheckoutViewModel(
    private val api: ApiClient,
    private val cart: CartStore,
    private val saved: SavedItemsStore,
    private val departmentId: String,
) : ViewModel() {
    data class UiState(
        val department: Department? = null,
        val departmentError: UiError? = null,
        val quote: QuoteResponse? = null,
        val quoting: Boolean = false,
        val quoteError: UiError? = null,
        val siteCode: String = "",
        val submitting: Boolean = false,
        val submitError: UiError? = null,
        /** 注文成功時のアクセストークン（画面遷移に使う） */
        val createdToken: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    val carts = cart.carts

    private val idempotency = IdempotencyKey()
    private var quoteJob: Job? = null

    init {
        loadDepartment()
        viewModelScope.launch {
            cart.carts.collect { requote() }
        }
    }

    fun loadDepartment() {
        viewModelScope.launch {
            try {
                val d = api.departments().firstOrNull { it.id == departmentId }
                _state.update { it.copy(department = d, departmentError = if (d == null) UiError.Server(404, "not_found", "") else null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(departmentError = e.toUiError()) }
            }
        }
    }

    private fun items(): List<OrderItemRequest> = cart.lines(departmentId).map { OrderItemRequest(it.variantId, it.quantity) }

    /** カートが変わるたびにサーバーで金額を計算し直す（表示金額はサーバーの見積を正とする）。 */
    fun requote() {
        quoteJob?.cancel()
        val items = items()
        if (items.isEmpty()) {
            _state.update { it.copy(quote = null, quoting = false, quoteError = null) }
            return
        }
        quoteJob = viewModelScope.launch {
            delay(300)
            _state.update { it.copy(quoting = true) }
            try {
                val q = api.quote(QuoteRequest(departmentId, items))
                _state.update { it.copy(quote = q, quoting = false, quoteError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(quote = null, quoting = false, quoteError = e.toUiError()) }
            }
        }
    }

    fun setQuantity(variantId: String, q: Int) = cart.setQuantity(departmentId, variantId, q)

    fun setSiteCode(v: String) {
        // 数字のみ・3桁まで。先頭の0を保つため文字列のまま扱う。
        val digits = v.filter { it in '0'..'9' }.take(3)
        _state.update { it.copy(siteCode = digits, submitError = null) }
    }

    fun submit() {
        val s = _state.value
        val dept = s.department ?: return
        if (s.submitting) return
        val items = items()
        if (items.isEmpty()) return
        val req = CreateOrderRequest(
            departmentId = departmentId,
            items = items,
            siteCode = if (dept.siteCodeEnabled) s.siteCode else null,
            channel = "android",
        )
        val key = idempotency.obtain(api.json.encodeToString(CreateOrderRequest.serializer(), req))
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            try {
                val res = api.createOrder(req, key)
                idempotency.settle(null)
                saved.upsert(
                    SavedItem(
                        kind = "order",
                        token = res.accessToken,
                        title = dept.name,
                        subtitle = res.callNumber.toString(),
                    ),
                )
                cart.clear(departmentId)
                _state.update { it.copy(submitting = false, createdToken = res.accessToken) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                idempotency.settle(e)
                _state.update { it.copy(submitting = false, submitError = e.toUiError()) }
            }
        }
    }

    fun consumeCreated() = _state.update { it.copy(createdToken = null) }
}

@Composable
fun CheckoutScreen(container: AppContainer, departmentId: String, onBack: () -> Unit, onOrdered: (String) -> Unit) {
    val vm: CheckoutViewModel = viewModel { CheckoutViewModel(container.api, container.cart, container.savedItems, departmentId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val carts by vm.carts.collectAsStateWithLifecycle()
    val lines = carts[departmentId].orEmpty()
    val dept = state.department

    LaunchedEffect(state.createdToken) {
        state.createdToken?.let {
            vm.consumeCreated()
            onOrdered(it)
        }
    }

    val siteCodeOk = dept?.siteCodeEnabled != true || state.siteCode.length == 3
    val canSubmit = dept != null && lines.isNotEmpty() && state.quote != null && state.quoteError == null &&
        !state.quoting && siteCodeOk && dept.acceptsMobileOrder

    ScreenScaffold(
        title = stringResource(R.string.checkout_title),
        onBack = onBack,
        bottomBar = {
            if (lines.isNotEmpty()) {
                Surface(tonalElevation = 6.dp) {
                    BigButton(
                        text = if (state.submitError is UiError.Network) stringResource(R.string.checkout_submit_retry)
                        else stringResource(R.string.checkout_submit),
                        onClick = vm::submit,
                        enabled = canSubmit,
                        loading = state.submitting,
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp),
                    )
                }
            }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            state.departmentError?.let { e -> item { ErrorPanel(e, onRetry = vm::loadDepartment) } }
            if (lines.isEmpty()) {
                item { Text(stringResource(R.string.checkout_empty), style = MaterialTheme.typography.titleMedium) }
                return@LazyColumn
            }
            item { Text(stringResource(R.string.checkout_cart_heading), style = MaterialTheme.typography.titleLarge) }
            items(lines, key = { it.variantId }) { line ->
                SectionCard {
                    Text(line.productName, style = MaterialTheme.typography.titleMedium)
                    if (line.optionsLabel.isNotBlank()) Text(line.optionsLabel, style = MaterialTheme.typography.bodyMedium)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        QuantityStepper(line.quantity, { vm.setQuantity(line.variantId, it) }, min = 1)
                        Spacer(Modifier.weight(1f))
                        IconButton(onClick = { vm.setQuantity(line.variantId, 0) }, modifier = Modifier.size(52.dp)) {
                            Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.checkout_remove))
                        }
                    }
                }
            }
            item {
                SectionCard {
                    Text(stringResource(R.string.checkout_quote_heading), style = MaterialTheme.typography.titleMedium)
                    val q = state.quote
                    when {
                        state.quoteError != null -> ErrorPanel(state.quoteError!!, onRetry = vm::requote)
                        q == null || state.quoting -> LoadingPanel()
                        else -> {
                            for (qi in q.items) {
                                Row {
                                    Text(
                                        stringResource(R.string.checkout_quote_line, qi.productName, qi.optionsLabel, qi.quantity),
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(formatYen(qi.lineTotal))
                                }
                            }
                            HorizontalDivider()
                            Row {
                                Text(stringResource(R.string.checkout_total), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                                Text(formatYen(q.subtotal), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                            }
                            Text(stringResource(R.string.checkout_pay_at_counter), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            if (dept != null && !dept.acceptsMobileOrder) {
                item { SectionCard { Text(stringResource(R.string.order_not_accepting)) } }
            }
            if (dept?.siteCodeEnabled == true) {
                item {
                    SectionCard {
                        Text(stringResource(R.string.site_code_heading), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.site_code_help), style = MaterialTheme.typography.bodyMedium)
                        OutlinedTextField(
                            value = state.siteCode,
                            onValueChange = vm::setSiteCode,
                            label = { Text(stringResource(R.string.site_code_label)) },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                            textStyle = MaterialTheme.typography.headlineMedium.copy(letterSpacing = 8.sp, textAlign = TextAlign.Center),
                            modifier = Modifier.fillMaxWidth(),
                            supportingText = { Text(stringResource(R.string.site_code_count, state.siteCode.length)) },
                        )
                    }
                }
            }
            state.submitError?.let { e ->
                item {
                    ErrorPanel(e, onRetry = if (e is UiError.Network) vm::submit else null)
                }
            }
        }
    }
}

// ================================================================ 注文状況（呼出番号）

class OrderStatusViewModel(
    private val api: ApiClient,
    private val saved: SavedItemsStore,
    private val token: String,
) : LoadViewModel<PublicOrder>() {
    private val _cancelling = MutableStateFlow(false)
    val cancelling: StateFlow<Boolean> = _cancelling.asStateFlow()
    private val _actionError = MutableStateFlow<UiError?>(null)
    val actionError: StateFlow<UiError?> = _actionError.asStateFlow()

    init {
        subscribe(api, "orders")
        poll(30_000L)
        start()
    }

    override suspend fun fetch(): PublicOrder = api.order(token)

    override fun onLoaded(data: PublicOrder) {
        saved.upsert(SavedItem(kind = "order", token = token, title = data.departmentName, subtitle = data.callNumber.toString()))
    }

    fun cancel() {
        if (_cancelling.value) return
        _cancelling.value = true
        _actionError.value = null
        viewModelScope.launch {
            try {
                replaceData(api.cancelOrder(token))
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
fun OrderStatusScreen(container: AppContainer, token: String, onBack: () -> Unit) {
    val vm: OrderStatusViewModel = viewModel { OrderStatusViewModel(container.api, container.savedItems, token) }
    val state by vm.state.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val cancelling by vm.cancelling.collectAsStateWithLifecycle()
    val actionError by vm.actionError.collectAsStateWithLifecycle()
    var confirm by rememberSaveable { mutableStateOf(false) }

    ScreenScaffold(title = stringResource(R.string.order_status_title), onBack = onBack) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { LastUpdatedBar(state.updatedAtMs, live = live, staleAfterMs = 90_000L, onRefresh = vm::refresh) }
            state.error?.let { e -> item { ErrorPanel(e, onRetry = vm::refresh) } }
            if (state.data == null && state.loading) item { LoadingPanel() }
            val o = state.data ?: return@LazyColumn
            item { CallNumberCard(o) }
            item {
                SectionCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StatusBadge(orderStatusLabel(o.status), if (o.status == "cancelled") StatusKind.Bad else StatusKind.Info)
                        StatusBadge(
                            paymentStatusLabel(o.paymentStatus),
                            if (o.paymentStatus == "unpaid") StatusKind.Warn else StatusKind.Ok,
                        )
                    }
                    if (o.status == "accepted" && o.paymentStatus == "unpaid") {
                        Text(stringResource(R.string.order_pay_at_counter), style = MaterialTheme.typography.bodyLarge)
                    }
                    Text(stringResource(R.string.order_created_at, formatDateTime(o.createdAt)), style = MaterialTheme.typography.bodySmall)
                }
            }
            item { Text(stringResource(R.string.order_items_heading), style = MaterialTheme.typography.titleMedium) }
            items(o.items, key = { it.id }) { item ->
                SectionCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                item.productName,
                                style = MaterialTheme.typography.titleMedium,
                                textDecoration = if (item.cookStatus == "cancelled") TextDecoration.LineThrough else null,
                            )
                            if (item.optionsLabel.isNotBlank()) Text(item.optionsLabel)
                            Text(stringResource(R.string.order_item_qty_price, item.quantity, formatYen(item.lineTotal)))
                        }
                        StatusBadge(cookStatusLabel(item.cookStatus), cookStatusKind(item.cookStatus))
                    }
                }
            }
            item {
                SectionCard {
                    if (o.discount > 0) {
                        Row {
                            Text(stringResource(R.string.order_discount), modifier = Modifier.weight(1f))
                            Text("−" + formatYen(o.discount))
                        }
                    }
                    Row {
                        Text(stringResource(R.string.checkout_total), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                        Text(formatYen(o.total), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    }
                }
            }
            actionError?.let { e -> item { ErrorPanel(e, onRetry = null) } }
            if (o.visitorCancellable) {
                item {
                    BigButton(
                        text = stringResource(R.string.order_cancel),
                        onClick = { confirm = true },
                        loading = cancelling,
                        outlined = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(stringResource(R.string.order_cancel_note), style = MaterialTheme.typography.bodySmall)
                }
            } else if (o.status == "accepted" && o.handoffStatus == "pending") {
                item { Text(stringResource(R.string.order_cancel_ask_staff), style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    if (confirm) {
        ConfirmDialog(
            title = stringResource(R.string.order_cancel_confirm_title),
            message = stringResource(R.string.order_cancel_confirm_message),
            confirmText = stringResource(R.string.order_cancel),
            onConfirm = {
                confirm = false
                vm.cancel()
            },
            onDismiss = { confirm = false },
        )
    }
}

@Composable
private fun CallNumberCard(o: PublicOrder) {
    val (headline, kind) = when {
        o.status == "cancelled" -> stringResource(R.string.order_headline_cancelled) to StatusKind.Bad
        o.handoffStatus == "handed" -> stringResource(R.string.order_headline_handed) to StatusKind.Ok
        o.ready -> stringResource(R.string.order_headline_ready) to StatusKind.Ok
        o.items.any { it.cookStatus == "cooking" } -> stringResource(R.string.order_headline_cooking) to StatusKind.Warn
        else -> stringResource(R.string.order_headline_waiting) to StatusKind.Neutral
    }
    Card(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(o.departmentName, style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.order_call_number), style = MaterialTheme.typography.titleMedium)
            Text(
                o.callNumber.toString(),
                fontSize = 96.sp,
                fontWeight = FontWeight.Black,
                lineHeight = 100.sp,
                textDecoration = if (o.status == "cancelled") TextDecoration.LineThrough else null,
            )
            StatusBadge(headline, kind)
            if (o.ready && o.paymentStatus == "unpaid") {
                Text(stringResource(R.string.order_ready_unpaid), textAlign = TextAlign.Center)
            } else if (o.ready && o.handoffStatus == "pending") {
                Text(stringResource(R.string.order_ready_note), textAlign = TextAlign.Center)
            }
        }
    }
}
