package jp.gakusai.portal.ui.common

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.view.WindowManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import jp.gakusai.portal.R
import jp.gakusai.portal.data.ApiException
import jp.gakusai.portal.data.NetworkException
import jp.gakusai.portal.data.ProtocolException
import jp.gakusai.portal.ui.theme.LocalStatusColors
import kotlinx.coroutines.delay
import java.text.NumberFormat
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// ---------------------------------------------------------------- エラー

/** 画面に出すエラー。サーバーのメッセージ（日本語）はそのまま表示する。 */
sealed interface UiError {
    data class Server(val status: Int, val code: String, val message: String) : UiError
    data object Network : UiError
    data object Protocol : UiError
    data object Unknown : UiError
}

fun Throwable.toUiError(): UiError = when (this) {
    is ApiException -> UiError.Server(status, code, message)
    is NetworkException -> UiError.Network
    is ProtocolException -> UiError.Protocol
    else -> UiError.Unknown
}

@Composable
fun errorText(error: UiError): String = when (error) {
    is UiError.Server -> error.message.ifBlank {
        when (error.status) {
            401 -> stringResource(R.string.error_unauthorized)
            403 -> stringResource(R.string.error_forbidden)
            404 -> stringResource(R.string.error_not_found)
            429 -> stringResource(R.string.error_rate_limited)
            else -> stringResource(R.string.error_server, error.status)
        }
    }
    UiError.Network -> stringResource(R.string.error_network)
    UiError.Protocol -> stringResource(R.string.error_protocol)
    UiError.Unknown -> stringResource(R.string.error_unknown)
}

/** エラー表示と再試行ボタン。 */
@Composable
fun ErrorPanel(error: UiError, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    val c = LocalStatusColors.current
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = c.bad)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = if (error is UiError.Network) stringResource(R.string.error_title_network) else stringResource(R.string.error_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
            Text(errorText(error), color = MaterialTheme.colorScheme.onErrorContainer)
            if (onRetry != null) {
                Button(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.Refresh, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.action_retry))
                }
            }
        }
    }
}

@Composable
fun LoadingPanel(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        val label = stringResource(R.string.loading)
        CircularProgressIndicator(Modifier.semantics { contentDescription = label })
    }
}

// ---------------------------------------------------------------- 最終更新・古いデータ警告

/** 現在時刻を一定間隔で更新する。 */
@Composable
fun rememberNow(intervalMs: Long = 1_000L): Long {
    val now by produceState(System.currentTimeMillis(), intervalMs) {
        while (true) {
            value = System.currentTimeMillis()
            delay(intervalMs)
        }
    }
    return now
}

/**
 * 「最終更新 HH:mm:ss」と、古くなったときの警告。
 * live が false（リアルタイム接続が切れている）ときも明示する。
 */
@Composable
fun LastUpdatedBar(
    lastUpdatedMs: Long?,
    modifier: Modifier = Modifier,
    staleAfterMs: Long = 60_000L,
    live: Boolean? = null,
    onRefresh: (() -> Unit)? = null,
) {
    val now = rememberNow(5_000L)
    val stale = lastUpdatedMs == null || now - lastUpdatedMs > staleAfterMs
    val c = LocalStatusColors.current
    val bg = if (stale) c.warn else MaterialTheme.colorScheme.surfaceVariant
    val fg = if (stale) c.onWarn else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier
            .fillMaxWidth()
            .background(bg, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (stale) Icons.Filled.Warning else Icons.Filled.Info, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = if (lastUpdatedMs == null) stringResource(R.string.last_updated_never)
                else stringResource(R.string.last_updated, formatClock(lastUpdatedMs)),
                color = fg,
                style = MaterialTheme.typography.bodySmall,
            )
            if (stale) {
                Text(stringResource(R.string.stale_warning), color = fg, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
            } else if (live == false) {
                Text(stringResource(R.string.live_disconnected), color = fg, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (onRefresh != null) {
            IconButton(onClick = onRefresh) {
                Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = fg)
            }
        }
    }
}

// ---------------------------------------------------------------- 状態バッジ

enum class StatusKind { Ok, Warn, Bad, Neutral, Info }

/** 色＋アイコン＋文字で状態を示す（色だけに依存しない）。 */
@Composable
fun StatusBadge(text: String, kind: StatusKind, modifier: Modifier = Modifier, icon: ImageVector? = defaultIcon(kind)) {
    val c = LocalStatusColors.current
    val (bg, fg) = when (kind) {
        StatusKind.Ok -> c.ok to c.onOk
        StatusKind.Warn -> c.warn to c.onWarn
        StatusKind.Bad -> c.bad to c.onBad
        StatusKind.Neutral -> c.neutral to c.onNeutral
        StatusKind.Info -> MaterialTheme.colorScheme.primary to MaterialTheme.colorScheme.onPrimary
    }
    Row(
        modifier
            .background(bg, RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(4.dp))
        }
        Text(text, color = fg, style = MaterialTheme.typography.labelLarge)
    }
}

private fun defaultIcon(kind: StatusKind): ImageVector? = when (kind) {
    StatusKind.Ok -> Icons.Filled.CheckCircle
    StatusKind.Warn -> Icons.Filled.Warning
    StatusKind.Bad -> Icons.Filled.Close
    StatusKind.Info -> Icons.Filled.Info
    StatusKind.Neutral -> null
}

// ---------------------------------------------------------------- ボタン・ダイアログ・枠

/** 大きめのタッチ領域（最小64dp）を持つボタン。 */
@Composable
fun BigButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
    outlined: Boolean = false,
    containerColor: Color? = null,
) {
    val content: @Composable () -> Unit = {
        if (loading) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(12.dp))
        } else if (icon != null) {
            Icon(icon, contentDescription = null)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
    val m = modifier.heightIn(min = 64.dp)
    if (outlined) {
        OutlinedButton(onClick = onClick, enabled = enabled && !loading, modifier = m, contentPadding = PaddingValues(horizontal = 20.dp)) { content() }
    } else {
        Button(
            onClick = onClick,
            enabled = enabled && !loading,
            modifier = m,
            contentPadding = PaddingValues(horizontal = 20.dp),
            colors = if (containerColor != null) ButtonDefaults.buttonColors(containerColor = containerColor) else ButtonDefaults.buttonColors(),
        ) { content() }
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmText: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.heightIn(min = 48.dp)) { Text(confirmText) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.action_back)) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    title: String,
    onBack: (() -> Unit)?,
    snackbarHostState: SnackbarHostState? = null,
    actions: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        bottomBar = bottomBar,
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                        }
                    }
                },
                actions = { actions() },
            )
        },
        snackbarHost = { if (snackbarHostState != null) SnackbarHost(snackbarHostState) },
        content = content,
    )
}

@Composable
fun SectionCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

// ---------------------------------------------------------------- QR

/** QRコードを描画する。tokenだけを埋め込み、個人情報は含めない。 */
@Composable
fun QrCode(content: String, modifier: Modifier = Modifier, size: Dp = 240.dp, description: String? = null) {
    val bitmap = remember(content) { encodeQr(content, 512) }
    Box(
        modifier
            .background(Color.White, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = description,
                modifier = Modifier.size(size),
                filterQuality = FilterQuality.None,
            )
        } else {
            Text(stringResource(R.string.qr_error), modifier = Modifier.size(size), color = Color.Black)
        }
    }
}

private fun encodeQr(content: String, px: Int): Bitmap? = runCatching {
    val hints = mapOf(
        EncodeHintType.MARGIN to 1,
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, px, px, hints)
    val w = matrix.width
    val h = matrix.height
    val pixels = IntArray(w * h)
    for (y in 0 until h) {
        val row = y * w
        for (x in 0 until w) pixels[row + x] = if (matrix[x, y]) AndroidColor.BLACK else AndroidColor.WHITE
    }
    Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
}.getOrNull()

/** QR表示中は画面を最大輝度・常時点灯にして読み取りやすくする。 */
@Composable
fun KeepScreenBright() {
    val context = LocalContext.current
    DisposableEffect(context) {
        val window = context.findActivity()?.window
        val oldBrightness = window?.attributes?.screenBrightness
        window?.let {
            it.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            it.attributes = it.attributes.apply { screenBrightness = 1f }
        }
        onDispose {
            window?.let {
                it.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                it.attributes = it.attributes.apply {
                    screenBrightness = oldBrightness ?: WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                }
            }
        }
    }
}

fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

// ---------------------------------------------------------------- 書式

private val TOKYO: ZoneId = ZoneId.of("Asia/Tokyo")
private val CLOCK = DateTimeFormatter.ofPattern("H:mm:ss", Locale.JAPAN)
private val TIME = DateTimeFormatter.ofPattern("H:mm", Locale.JAPAN)
private val DATE_TIME = DateTimeFormatter.ofPattern("M月d日(E) H:mm", Locale.JAPAN)
private val DAY = DateTimeFormatter.ofPattern("M月d日(E)", Locale.JAPAN)

fun formatYen(amount: Int): String = "¥" + NumberFormat.getIntegerInstance(Locale.JAPAN).format(amount)

fun formatClock(epochMs: Long): String =
    java.time.Instant.ofEpochMilli(epochMs).atZone(TOKYO).format(CLOCK)

private fun parse(iso: String?): OffsetDateTime? =
    if (iso.isNullOrBlank()) null else runCatching { OffsetDateTime.parse(iso) }.getOrNull()

/** "10:00" */
fun formatTime(iso: String?): String = parse(iso)?.atZoneSameInstant(TOKYO)?.format(TIME) ?: iso.orEmpty()

/** "10月17日(土) 10:00" */
fun formatDateTime(iso: String?): String = parse(iso)?.atZoneSameInstant(TOKYO)?.format(DATE_TIME) ?: iso.orEmpty()

/** "2026-10-17" → "10月17日(土)" */
fun formatDay(day: String): String =
    runCatching { java.time.LocalDate.parse(day).format(DAY) }.getOrDefault(day)

/** "12:34" 形式の経過時間（分:秒） */
fun formatElapsed(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s % 3600) / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/** 画面いっぱいの中央寄せ領域。 */
@Composable
fun CenteredBox(padding: PaddingValues, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(padding).padding(16.dp), contentAlignment = Alignment.Center) { content() }
}
