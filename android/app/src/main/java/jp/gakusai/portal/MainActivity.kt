package jp.gakusai.portal

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import jp.gakusai.portal.ui.AppNavHost
import jp.gakusai.portal.ui.Routes
import jp.gakusai.portal.ui.theme.GakusaiTheme

class MainActivity : ComponentActivity() {
    /** App Links で開かれたときの遷移先（処理後に null に戻す）。 */
    private val pendingRoute = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handleIntent(intent)
        val container = (application as GakusaiApp).container
        setContent {
            GakusaiTheme {
                AppNavHost(
                    container = container,
                    pendingRoute = pendingRoute.value,
                    onPendingRouteHandled = { pendingRoute.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        DeepLinks.routeFor(uri)?.let { pendingRoute.value = it }
    }
}

/** https://<domain>/order/{deptId}, /r/{token}, /c/{token}, /o/{token} をアプリ内の画面に対応づける。 */
object DeepLinks {
    private val SAFE = Regex("^[A-Za-z0-9_-]{1,200}$")

    fun routeFor(uri: Uri): String? {
        val segs = uri.pathSegments ?: return null
        if (segs.size < 2) return null
        val value = segs[1]
        if (!SAFE.matches(value)) return null
        return when (segs[0]) {
            "order" -> Routes.menu(value)
            "r" -> Routes.reservation(value)
            "c" -> Routes.coupon(value)
            "o" -> Routes.orderStatus(value)
            else -> null
        }
    }
}
