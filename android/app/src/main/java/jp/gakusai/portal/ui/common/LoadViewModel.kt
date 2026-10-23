package jp.gakusai.portal.ui.common

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.gakusai.portal.data.ApiClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** 取得データ・読み込み中・エラー・最終更新時刻。エラーでも直前のデータは残す（古さは最終更新で示す）。 */
data class LoadState<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val error: UiError? = null,
    val updatedAtMs: Long? = null,
)

/**
 * サーバーから1つのデータを取得して表示する画面の共通処理。
 * - refresh() の要求はまとめて順番に処理する（連打・SSE連続通知でも同時に何本も取得しない）。
 * - subscribe() で SSE を購読し、通知・再接続のたびに取り直す。
 * - poll() で SSE が使えない環境向けの定期取得を行う。
 */
abstract class LoadViewModel<T> : ViewModel() {
    private val _state = MutableStateFlow(LoadState<T>())
    val state: StateFlow<LoadState<T>> = _state.asStateFlow()

    private val _live = MutableStateFlow<Boolean?>(null)

    /** null: 未使用 / true: リアルタイム接続中 / false: 切断中 */
    val live: StateFlow<Boolean?> = _live.asStateFlow()

    private val requests = Channel<Unit>(Channel.CONFLATED)
    private var started = false

    protected abstract suspend fun fetch(): T

    /** 取得成功時の追加処理（保存など）。 */
    protected open fun onLoaded(data: T) {}

    /** サブクラスの初期化の最後に呼ぶ。 */
    protected fun start() {
        if (started) return
        started = true
        viewModelScope.launch {
            for (r in requests) load()
        }
        refresh()
    }

    fun refresh() {
        requests.trySend(Unit)
    }

    /** 操作の結果として得た最新データで置き換える。 */
    protected fun replaceData(data: T) {
        _state.value = LoadState(data = data, loading = false, error = null, updatedAtMs = System.currentTimeMillis())
        onLoaded(data)
    }

    private suspend fun load() {
        _state.update { it.copy(loading = true) }
        try {
            val d = fetch()
            replaceData(d)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loading = false, error = e.toUiError()) }
        }
    }

    protected fun subscribe(api: ApiClient, topics: String) {
        viewModelScope.launch {
            api.events(topics).collect { signal ->
                when (signal) {
                    ApiClient.StreamSignal.Connected -> {
                        _live.value = true
                        refresh()
                    }
                    is ApiClient.StreamSignal.Change -> refresh()
                    ApiClient.StreamSignal.Disconnected -> _live.value = false
                }
            }
        }
    }

    protected fun poll(intervalMs: Long) {
        viewModelScope.launch {
            while (true) {
                delay(intervalMs)
                refresh()
            }
        }
    }
}
