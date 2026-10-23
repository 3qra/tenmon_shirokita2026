package jp.gakusai.portal.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * 秘密値（スタッフのセッショントークン、予約・注文・クーポンのアクセストークン）を保存する。
 * EncryptedSharedPreferences が使えない端末では保存せずメモリだけで保持する（平文保存はしない）。
 */
class SecureKeyValue(context: Context, name: String) {
    private val prefs: SharedPreferences? = open(context.applicationContext, name)
    private val memory = mutableMapOf<String, String>()

    val persistent: Boolean get() = prefs != null

    fun get(key: String): String? = prefs?.getString(key, null) ?: memory[key]

    fun put(key: String, value: String) {
        if (prefs != null) prefs.edit().putString(key, value).apply() else memory[key] = value
    }

    fun remove(key: String) {
        prefs?.edit()?.remove(key)?.apply()
        memory.remove(key)
    }

    private companion object {
        fun open(context: Context, name: String): SharedPreferences? {
            repeat(2) { attempt ->
                try {
                    val key = MasterKey.Builder(context)
                        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                        .build()
                    return EncryptedSharedPreferences.create(
                        context,
                        name,
                        key,
                        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                    )
                } catch (e: Exception) {
                    // 鍵が壊れた等。1回目は作り直しを試みる。
                    Log.w("SecureKeyValue", "encrypted prefs unavailable (attempt ${attempt + 1})", e)
                    context.deleteSharedPreferences(name)
                }
            }
            return null
        }
    }
}

/** 来場者識別（X-Client-Id）。端末内にランダムなUUIDを1つ保持する。秘密値ではない。 */
class ClientIdStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("client_identity", Context.MODE_PRIVATE)

    val clientId: String by lazy {
        prefs.getString(KEY, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY, it).apply()
        }
    }

    private companion object {
        const val KEY = "client_id"
    }
}

/** スタッフのログイン状態。トークンは暗号化して保存する。 */
class StaffSessionStore(private val kv: SecureKeyValue, private val json: Json) {
    private val _staff = MutableStateFlow(loadStaff())
    val staff: StateFlow<StaffMember?> = _staff.asStateFlow()

    val token: String? get() = kv.get(KEY_TOKEN)

    fun save(token: String, staff: StaffMember) {
        kv.put(KEY_TOKEN, token)
        kv.put(KEY_STAFF, json.encodeToString(StaffMember.serializer(), staff))
        _staff.value = staff
    }

    fun clear() {
        kv.remove(KEY_TOKEN)
        kv.remove(KEY_STAFF)
        _staff.value = null
    }

    private fun loadStaff(): StaffMember? {
        if (kv.get(KEY_TOKEN) == null) return null
        val raw = kv.get(KEY_STAFF) ?: return null
        return runCatching { json.decodeFromString(StaffMember.serializer(), raw) }.getOrNull()
    }

    private companion object {
        const val KEY_TOKEN = "staff_token"
        const val KEY_STAFF = "staff_member"
    }
}

/** マイチケットに保存した項目。token は秘密値なので暗号化ストアに置く。 */
@Serializable
data class SavedItem(
    /** order / reservation / coupon */
    val kind: String,
    val token: String,
    val title: String,
    val subtitle: String = "",
    val savedAtEpochMs: Long = System.currentTimeMillis(),
)

class SavedItemsStore(private val kv: SecureKeyValue, private val json: Json) {
    private val serializer = ListSerializer(SavedItem.serializer())
    private val _items = MutableStateFlow(load())
    val items: StateFlow<List<SavedItem>> = _items.asStateFlow()

    /** 同じ token があれば内容を更新し、先頭に移動する。 */
    fun upsert(item: SavedItem) {
        _items.update { list ->
            val old = list.firstOrNull { it.kind == item.kind && it.token == item.token }
            val merged = if (old != null) item.copy(savedAtEpochMs = old.savedAtEpochMs) else item
            (listOf(merged) + list.filterNot { it.kind == item.kind && it.token == item.token }).take(MAX)
        }
        persist()
    }

    fun remove(kind: String, token: String) {
        _items.update { list -> list.filterNot { it.kind == kind && it.token == token } }
        persist()
    }

    private fun persist() {
        kv.put(KEY, json.encodeToString(serializer, _items.value))
    }

    private fun load(): List<SavedItem> {
        val raw = kv.get(KEY) ?: return emptyList()
        return runCatching { json.decodeFromString(serializer, raw) }.getOrDefault(emptyList())
    }

    private companion object {
        const val KEY = "saved_items"
        const val MAX = 50
    }
}

/** カートの1行。価格は表示用の目安で、確定金額は必ずサーバーの見積を使う。 */
data class CartLine(
    val variantId: String,
    val productName: String,
    val optionsLabel: String,
    val unitPrice: Int,
    val quantity: Int,
)

/** アプリ内で共有するカート（部門ごとに1つ）。 */
class CartStore {
    private val _carts = MutableStateFlow<Map<String, List<CartLine>>>(emptyMap())
    val carts: StateFlow<Map<String, List<CartLine>>> = _carts.asStateFlow()

    fun lines(departmentId: String): List<CartLine> = _carts.value[departmentId].orEmpty()

    fun add(departmentId: String, line: CartLine) {
        _carts.update { map ->
            val current = map[departmentId].orEmpty()
            val existing = current.firstOrNull { it.variantId == line.variantId }
            val next = if (existing != null) {
                current.map {
                    if (it.variantId == line.variantId) it.copy(quantity = (it.quantity + line.quantity).coerceAtMost(MAX_QTY)) else it
                }
            } else {
                current + line
            }
            map + (departmentId to next)
        }
    }

    fun setQuantity(departmentId: String, variantId: String, quantity: Int) {
        _carts.update { map ->
            val current = map[departmentId].orEmpty()
            val next = if (quantity <= 0) {
                current.filterNot { it.variantId == variantId }
            } else {
                current.map { if (it.variantId == variantId) it.copy(quantity = quantity.coerceAtMost(MAX_QTY)) else it }
            }
            map + (departmentId to next)
        }
    }

    fun clear(departmentId: String) {
        _carts.update { it - departmentId }
    }

    companion object {
        const val MAX_QTY = 99
    }
}
