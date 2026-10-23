package jp.gakusai.portal.ui.staff

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** カメラ権限の状態と要求。 */
class CameraPermissionState(
    val granted: Boolean,
    /** 一度要求して拒否された */
    val denied: Boolean,
    val request: () -> Unit,
)

@Composable
fun rememberCameraPermission(): CameraPermissionState {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(hasCamera(context)) }
    var denied by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        denied = !ok
    }
    // 設定画面から戻ってきたときなどに再確認
    LaunchedEffect(Unit) { granted = hasCamera(context) }
    return CameraPermissionState(granted, denied) { launcher.launch(Manifest.permission.CAMERA) }
}

private fun hasCamera(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

/**
 * QRコードを読み取るカメラプレビュー（CameraX + ML Kit）。
 * enabled=false の間は読み取り結果を通知しない（結果表示中・通信中）。
 * 同じ内容を続けて読んだ場合は一定時間通知しない。
 */
@Composable
fun QrScanner(enabled: Boolean, onScanned: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnScanned by rememberUpdatedState(onScanned)
    val enabledState = rememberUpdatedState(enabled)
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }

    DisposableEffect(lifecycleOwner) {
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
        var lastValue: String? = null
        var lastAt = 0L
        val analyzer = QrAnalyzer(scanner) { value ->
            mainExecutor.execute {
                val now = System.currentTimeMillis()
                if (!enabledState.value) return@execute
                if (value == lastValue && now - lastAt < 3_000L) return@execute
                lastValue = value
                lastAt = now
                currentOnScanned(value)
            }
        }
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        providerFuture.addListener({
            if (disposed) return@addListener
            try {
                val p = providerFuture.get()
                provider = p
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(analysisExecutor, analyzer) }
                p.unbindAll()
                p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                Log.e("QrScanner", "camera bind failed", e)
            }
        }, mainExecutor)

        onDispose {
            disposed = true
            provider?.unbindAll()
            analysisExecutor.shutdown()
            scanner.close()
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

private class QrAnalyzer(
    private val scanner: BarcodeScanner,
    private val onValue: (String) -> Unit,
) : ImageAnalysis.Analyzer {
    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val media = image.image
        if (media == null) {
            image.close()
            return
        }
        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { codes ->
                codes.firstNotNullOfOrNull { it.rawValue?.trim()?.takeIf { v -> v.isNotEmpty() } }?.let(onValue)
            }
            .addOnCompleteListener { image.close() }
    }
}

/** QRの中身から token を取り出す（URL形式なら最後のパス要素）。 */
fun extractToken(raw: String): String {
    val v = raw.trim()
    val path = v.substringBefore('?').substringBefore('#').trimEnd('/')
    return if (path.contains('/')) path.substringAfterLast('/') else path
}
