package jp.gakusai.portal

import android.app.Application
import android.content.Context
import jp.gakusai.portal.data.ApiClient
import jp.gakusai.portal.data.CartStore
import jp.gakusai.portal.data.ClientIdStore
import jp.gakusai.portal.data.SavedItemsStore
import jp.gakusai.portal.data.SecureKeyValue
import jp.gakusai.portal.data.StaffSessionStore
import kotlinx.serialization.json.Json

/** アプリ全体で共有する依存関係。 */
class AppContainer(context: Context) {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
        encodeDefaults = true
    }
    private val secure = SecureKeyValue(context, "gakusai_secure")
    val clientIds = ClientIdStore(context)
    val staffSession = StaffSessionStore(secure, json)
    val savedItems = SavedItemsStore(secure, json)
    val cart = CartStore()
    val api = ApiClient(BuildConfig.API_BASE_URL, clientIds, staffSession, json)
    val webBaseUrl: String = BuildConfig.WEB_BASE_URL.trimEnd('/')
}

class GakusaiApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
