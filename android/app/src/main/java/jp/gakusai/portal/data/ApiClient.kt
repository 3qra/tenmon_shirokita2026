package jp.gakusai.portal.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** APIが {"error":{code,message}} で返したエラー。message はそのまま利用者に表示してよい日本語。 */
class ApiException(val status: Int, val code: String, override val message: String) : Exception(message) {
    /** 同じ Idempotency-Key で再送してよい一時的な失敗か（サーバーは 5xx/409/429 の記録を残さない）。 */
    val retryable: Boolean get() = status >= 500 || status == 409 || status == 429
}

/** 通信できなかった（圏外・タイムアウト等）。同じ Idempotency-Key で再送できる。 */
class NetworkException(cause: Throwable) : Exception(cause.message, cause)

/** レスポンスが想定と違う（API とのバージョン不一致など）。 */
class ProtocolException(cause: Throwable) : Exception(cause.message, cause)

/**
 * 1回の利用者操作につき1つの Idempotency-Key を発行する。
 * - 通信失敗や一時的エラーで再試行するときは同じキーを再利用する。
 * - 送る内容が変わったとき、または成功・確定的なエラーで操作が完了したときは次回に新しいキーを作る。
 */
class IdempotencyKey {
    private var key: String? = null
    private var signature: String? = null

    @Synchronized
    fun obtain(signature: String): String {
        val k = key
        if (k != null && this.signature == signature) return k
        return UUID.randomUUID().toString().also {
            key = it
            this.signature = signature
        }
    }

    /** 結果に応じてキーを捨てるか判断する。 */
    @Synchronized
    fun settle(error: Throwable?) {
        val keep = error is NetworkException || (error is ApiException && error.retryable)
        if (!keep) {
            key = null
            signature = null
        }
    }
}

class ApiClient(
    baseUrl: String,
    private val clientIds: ClientIdStore,
    private val session: StaffSessionStore,
    val json: Json,
) {
    private val apiBase = baseUrl.trimEnd('/') + "/api/v1"

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    // SSE はサーバーが15秒ごとに ping を送るので、60秒無通信なら切断とみなす。
    private val sseHttp: OkHttpClient = http.newBuilder()
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()

    private val _unauthorized = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** スタッフAPIが401を返した（セッション切れ）。画面側でログインへ戻す。 */
    val unauthorized: SharedFlow<Unit> = _unauthorized.asSharedFlow()

    // ------------------------------------------------------------ 公開API

    suspend fun departments(): List<Department> =
        get("/public/departments", ListSerializer(Department.serializer()))

    suspend fun catalog(departmentId: String): CatalogResponse =
        get("/public/departments/${seg(departmentId)}/products", CatalogResponse.serializer())

    suspend fun quote(req: QuoteRequest): QuoteResponse =
        post("/public/orders/quote", req, QuoteRequest.serializer(), QuoteResponse.serializer())

    suspend fun createOrder(req: CreateOrderRequest, idempotencyKey: String): CreateOrderResponse =
        post("/public/orders", req, CreateOrderRequest.serializer(), CreateOrderResponse.serializer(), idempotencyKey = idempotencyKey)

    suspend fun order(token: String): PublicOrder =
        get("/public/orders/by-token/${seg(token)}", PublicOrder.serializer())

    suspend fun cancelOrder(token: String): PublicOrder =
        postEmpty("/public/orders/by-token/${seg(token)}/cancel", PublicOrder.serializer())

    suspend fun screenings(day: String? = null): PublicScreeningsResponse =
        get("/public/screenings" + (day?.let { "?day=${seg(it)}" } ?: ""), PublicScreeningsResponse.serializer())

    suspend fun screening(id: String): PublicScreeningDetail =
        get("/public/screenings/${seg(id)}", PublicScreeningDetail.serializer())

    suspend fun createReservation(req: CreateReservationRequest, idempotencyKey: String): CreateReservationResponse =
        post(
            "/public/reservations", req, CreateReservationRequest.serializer(), CreateReservationResponse.serializer(),
            idempotencyKey = idempotencyKey,
        )

    suspend fun reservation(token: String): ReservationDetail =
        get("/public/reservations/by-token/${seg(token)}", ReservationDetail.serializer())

    suspend fun cancelReservation(token: String): ReservationDetail =
        postEmpty("/public/reservations/by-token/${seg(token)}/cancel", ReservationDetail.serializer())

    suspend fun coupon(token: String): PublicCoupon =
        get("/public/coupons/by-token/${seg(token)}", PublicCoupon.serializer())

    // ------------------------------------------------------------ スタッフAPI

    suspend fun login(loginId: String, password: String): LoginResponse =
        post("/auth/login", LoginRequest(loginId, password), LoginRequest.serializer(), LoginResponse.serializer())

    suspend fun logout() {
        postEmpty("/auth/logout", OkResponse.serializer(), auth = true)
    }

    suspend fun staffDepartments(): List<Department> =
        get("/staff/departments", ListSerializer(Department.serializer()), auth = true)

    suspend fun staffScreenings(): StaffScreeningsResponse =
        get("/staff/screenings", StaffScreeningsResponse.serializer(), auth = true)

    suspend fun checkinVerify(req: CheckinRequest): CheckinResult =
        post("/staff/checkin/verify", req, CheckinRequest.serializer(), CheckinResult.serializer(), auth = true)

    suspend fun checkin(req: CheckinRequest, idempotencyKey: String): CheckinResult =
        post("/staff/checkin", req, CheckinRequest.serializer(), CheckinResult.serializer(), auth = true, idempotencyKey = idempotencyKey)

    suspend fun verifyCoupon(token: String): CouponVerifyResponse =
        get("/staff/coupons/verify/${seg(token)}", CouponVerifyResponse.serializer(), auth = true)

    suspend fun kitchen(departmentId: String): KitchenResponse =
        get("/staff/kitchen?department_id=${seg(departmentId)}", KitchenResponse.serializer(), auth = true)

    suspend fun cook(itemId: String, from: String, to: String): CookResponse =
        post("/staff/order-items/${seg(itemId)}/cook", CookRequest(from, to), CookRequest.serializer(), CookResponse.serializer(), auth = true)

    // ------------------------------------------------------------ SSE

    sealed interface StreamSignal {
        /** 接続（再接続）できた。取りこぼしがありうるので全件を取り直す。 */
        data object Connected : StreamSignal

        /** トピックが変わった。最新状態をAPIで取り直す（通知＝業務成功ではない）。 */
        data class Change(val topic: String) : StreamSignal

        data object Disconnected : StreamSignal
    }

    /** GET /events?topics=... を購読し続ける。切断時は指数バックオフで再接続する。 */
    fun events(topics: String): Flow<StreamSignal> = flow {
        var backoffMs = 1_000L
        while (true) {
            singleStream(topics).collect { signal ->
                if (signal is StreamSignal.Connected) backoffMs = 1_000L
                emit(signal)
            }
            emit(StreamSignal.Disconnected)
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    private fun singleStream(topics: String): Flow<StreamSignal> = callbackFlow {
        val request = Request.Builder()
            .url("$apiBase/events?topics=${seg(topics)}")
            .header("Accept", "text/event-stream")
            .header("X-Client-Kind", "android")
            .build()
        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                trySend(StreamSignal.Connected)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (type == "change") trySend(StreamSignal.Change(data))
            }

            override fun onClosed(eventSource: EventSource) {
                channel.close()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                response?.close()
                channel.close()
            }
        }
        val source = EventSources.createFactory(sseHttp).newEventSource(request, listener)
        awaitClose { source.cancel() }
    }

    // ------------------------------------------------------------ 共通処理

    private suspend fun <T> get(path: String, out: KSerializer<T>, auth: Boolean = false): T =
        execute(buildRequest(path, auth, null).get().build(), out, auth)

    private suspend fun <I, T> post(
        path: String,
        body: I,
        input: KSerializer<I>,
        out: KSerializer<T>,
        auth: Boolean = false,
        idempotencyKey: String? = null,
    ): T {
        val payload = json.encodeToString(input, body).toRequestBody(JSON)
        return execute(buildRequest(path, auth, idempotencyKey).post(payload).build(), out, auth)
    }

    private suspend fun <T> postEmpty(path: String, out: KSerializer<T>, auth: Boolean = false): T =
        execute(buildRequest(path, auth, null).post("{}".toRequestBody(JSON)).build(), out, auth)

    private fun buildRequest(path: String, auth: Boolean, idempotencyKey: String?): Request.Builder {
        val b = Request.Builder()
            .url(apiBase + path)
            .header("Accept", "application/json")
            // Cookie を使わない独自クライアントであることを示す（CSRF対策ヘッダ）
            .header("X-Requested-With", "android")
            .header("X-Client-Id", clientIds.clientId)
            .header("X-Client-Kind", "android")
        if (auth) session.token?.let { b.header("Authorization", "Bearer $it") }
        if (idempotencyKey != null) b.header("Idempotency-Key", idempotencyKey)
        return b
    }

    private suspend fun <T> execute(request: Request, out: KSerializer<T>, auth: Boolean): T {
        val response = try {
            http.newCall(request).await()
        } catch (e: IOException) {
            throw NetworkException(e)
        }
        return response.use { res ->
            val text = try {
                res.body?.string().orEmpty()
            } catch (e: IOException) {
                throw NetworkException(e)
            }
            if (!res.isSuccessful) {
                val err = runCatching { json.decodeFromString(ErrorEnvelope.serializer(), text).error }.getOrNull()
                if (res.code == 401 && auth) {
                    session.clear()
                    _unauthorized.tryEmit(Unit)
                }
                throw ApiException(
                    status = res.code,
                    code = err?.code?.ifBlank { null } ?: "http_${res.code}",
                    message = err?.message?.ifBlank { null } ?: "",
                )
            }
            try {
                json.decodeFromString(out, text)
            } catch (e: SerializationException) {
                throw ProtocolException(e)
            } catch (e: IllegalArgumentException) {
                throw ProtocolException(e)
            }
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                cont.resume(response)
            }

            override fun onFailure(call: Call, e: IOException) {
                if (!cont.isCancelled) cont.resumeWithException(e)
            }
        })
        cont.invokeOnCancellation { runCatching { this@await.cancel() } }
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()

        /** パス・クエリの1要素として安全にエンコードする。 */
        fun seg(v: String): String = java.net.URLEncoder.encode(v, "UTF-8").replace("+", "%20")
    }
}
