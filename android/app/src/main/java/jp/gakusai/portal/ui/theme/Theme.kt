package jp.gakusai.portal.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val Navy = Color(0xFF1B2A4E)
private val Star = Color(0xFFF4C542)

private val LightColors = lightColorScheme(
    primary = Color(0xFF2B4C8C),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE4FF),
    onPrimaryContainer = Navy,
    secondary = Color(0xFF8A6A00),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFE9A8),
    onSecondaryContainer = Color(0xFF2B2000),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFB4C5FF),
    onPrimary = Color(0xFF0F2556),
    primaryContainer = Color(0xFF2B4C8C),
    onPrimaryContainer = Color(0xFFDCE4FF),
    secondary = Star,
    onSecondary = Color(0xFF3D2F00),
    secondaryContainer = Color(0xFF5A4500),
    onSecondaryContainer = Color(0xFFFFE9A8),
)

/** 状態表示用の色。色だけに頼らず、必ずアイコン・文字と組み合わせて使う。 */
@Immutable
data class StatusColors(
    val ok: Color,
    val onOk: Color,
    val warn: Color,
    val onWarn: Color,
    val bad: Color,
    val onBad: Color,
    val neutral: Color,
    val onNeutral: Color,
)

private val LightStatus = StatusColors(
    ok = Color(0xFF1E7A3A), onOk = Color.White,
    warn = Color(0xFFB86E00), onWarn = Color.White,
    bad = Color(0xFFB3261E), onBad = Color.White,
    neutral = Color(0xFF5F6368), onNeutral = Color.White,
)

private val DarkStatus = StatusColors(
    ok = Color(0xFF7DDB95), onOk = Color(0xFF00391A),
    warn = Color(0xFFFFB866), onWarn = Color(0xFF452B00),
    bad = Color(0xFFFFB4AB), onBad = Color(0xFF690005),
    neutral = Color(0xFFC4C7C5), onNeutral = Color(0xFF2D3133),
)

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

@Composable
fun GakusaiTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    androidx.compose.runtime.CompositionLocalProvider(LocalStatusColors provides if (dark) DarkStatus else LightStatus) {
        MaterialTheme(
            colorScheme = if (dark) DarkColors else LightColors,
            typography = Typography(),
            content = content,
        )
    }
}
