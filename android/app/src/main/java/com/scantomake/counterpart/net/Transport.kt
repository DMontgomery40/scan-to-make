package com.scantomake.counterpart.net

import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.pairing.CompanionAddress
import com.scantomake.counterpart.pairing.CompanionTrust
import com.scantomake.counterpart.pairing.NearbyCrypto
import com.scantomake.counterpart.pairing.PairingRecord
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One HTTP answer from the companion. */
class HttpReply(val status: Int, val body: ByteArray, val headers: Map<String, String> = emptyMap()) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** A transport failure: `network`, `timeout`, `certificate`, `certificate-changed`, `too-large` or `cancelled`. */
class TransportException(val code: String) : IOException(code)

/** One request, as CounterpartKit builds a URLRequest. `timeoutMs` is the idle timeout. */
class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    val contentType: String? = null,
    val timeoutMs: Long = 90_000,
)

/** The key a nearby session saw first (S), shared by its requests. */
class NearbySeen { @Volatile var key: ByteArray? = null }

/** Who the server must be for a request. */
sealed class TrustPolicy {
    /** The paired companion: its pin when it has one (v1 certificate, v2 public key), else system trust. */
    data class Record(val record: PairingRecord) : TrustPolicy()
    /** A pairing attempt at one address, pinned like the record it would become. */
    data class Pending(val record: PairingRecord) : TrustPolicy()
    /** Nearby pairing: trust on first use, then only that key. */
    class Nearby(val base: String, val seen: NearbySeen) : TrustPolicy()
}

interface HttpTransport {
    suspend fun send(request: HttpRequest, trust: TrustPolicy, limit: Int, resourceTimeoutMs: Long): HttpReply
}

/** The server's certificate isn't the pinned one. */
class PinMismatchException : CertificateException("pin")

/**
 * OkHttp with exactly the pinning the iPhone app uses (CounterpartKit `PinnedTransport`): a pinned companion is
 * trusted only by its certificate or key, on its own host and port; redirects are refused; replies over
 * `limit` bytes are cut off as they arrive, never buffered first.
 */
class PinnedTransport : HttpTransport {
    private val base: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .build()
    private val pinnedClients = ConcurrentHashMap<String, OkHttpClient>()

    private val systemTrust: X509TrustManager by lazy {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as java.security.KeyStore?)
        factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /**
     * A trust manager that accepts exactly one leaf: `check` decides from its DER bytes. This is certificate
     * pinning (the companion's certificate is self-signed, so system trust can't vouch for it), never "trust all":
     * every other certificate is refused. Unpinned (Tailscale) companions use the system's own trust.
     */
    @android.annotation.SuppressLint("CustomX509TrustManager")
    private class LeafTrust(private val check: (ByteArray) -> Unit) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("client")
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("empty")
            check(leaf.encoded)
        }
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun pinnedClient(base: String, trust: X509TrustManager): OkHttpClient {
        val (host, port) = CompanionAddress.hostPort(base)
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        // The pin already proves who this is; the name check makes sure it's on the paired host and port.
        val verifier = HostnameVerifier { name, session -> CompanionTrust.sameHost(name, host) && (session.peerPort == port || session.peerPort == -1) }
        return this.base.newBuilder().sslSocketFactory(context.socketFactory, trust).hostnameVerifier(verifier).build()
    }

    private fun clientFor(policy: TrustPolicy): OkHttpClient = when (policy) {
        is TrustPolicy.Record, is TrustPolicy.Pending -> {
            val record = if (policy is TrustPolicy.Record) policy.record else (policy as TrustPolicy.Pending).record
            val pin = record.pin
            val baseUrl = record.requestBaseURL
            if (pin == null || baseUrl == null) base
            else {
                val build = {
                    pinnedClient(baseUrl, LeafTrust { der ->
                        val pinned = if (record.publicKeySha256 != null) CompanionTrust.subjectPublicKeyInfo(der) else der
                        if (pinned?.let(Hex::sha256) != pin) throw PinMismatchException()
                    })
                }
                // Requests to the same paired address and pin share connections; a pairing attempt never does.
                if (policy is TrustPolicy.Record) pinnedClients.getOrPut("${record.publicKeySha256 != null}|$pin|$baseUrl") { build() } else build()
            }
        }
        is TrustPolicy.Nearby -> pinnedClient(policy.base, LeafTrust { der ->
            val (host, port) = CompanionAddress.hostPort(policy.base)
            val key = NearbyCrypto.trust(host, port, der, policy.base, policy.seen.key)
            if (key == null) { if (policy.seen.key != null) throw PinMismatchException() else throw CertificateException("unreadable") }
            policy.seen.key = key
        })
    }

    override suspend fun send(request: HttpRequest, trust: TrustPolicy, limit: Int, resourceTimeoutMs: Long): HttpReply {
        val client = clientFor(trust).newBuilder()
            .connectTimeout(request.timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(request.timeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(request.timeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(resourceTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
        val builder = Request.Builder().url(request.url)
        for ((k, v) in request.headers) builder.header(k, v)
        val body = request.body?.toRequestBody(request.contentType?.toMediaTypeOrNull())
            ?: if (request.method == "POST" || request.method == "PUT" || request.method == "PATCH") ByteArray(0).toRequestBody(null) else null
        builder.method(request.method, body)
        val call = client.newCall(builder.build())
        val response = try { call.await() } catch (e: IOException) { throw map(e, call) }
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { response.use { r ->
            val declared = r.body?.contentLength() ?: -1
            if (declared > limit) throw TransportException("too-large")
            val bytes = try { readBounded(r, limit) } catch (e: TransportException) { throw e } catch (e: IOException) { throw map(e, call) }
            val headers = LinkedHashMap<String, String>()
            for (name in r.headers.names()) headers[name] = r.headers[name] ?: ""
            HttpReply(r.code, bytes, headers)
        } }
    }

    private fun readBounded(response: Response, limit: Int): ByteArray {
        val source = response.body?.byteStream() ?: return ByteArray(0)
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val n = source.read(buffer)
            if (n < 0) break
            if (out.size() + n > limit) throw TransportException("too-large")
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    companion object {
        fun map(error: Throwable, call: Call? = null): TransportException {
            if (error is TransportException) return error
            if (call?.isCanceled() == true) return TransportException("cancelled")
            var cause: Throwable? = error
            while (cause != null) {
                if (cause is PinMismatchException) return TransportException("certificate-changed")
                cause = cause.cause
            }
            return when (error) {
                is SocketTimeoutException -> TransportException("timeout")
                is SSLException -> TransportException("certificate")
                is InterruptedIOException -> if (error.message == "timeout") TransportException("timeout") else TransportException("network")
                else -> TransportException("network")
            }
        }
    }
}

/** Runs the call on OkHttp's dispatcher; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) { continuation.resume(response) }
        override fun onFailure(call: Call, e: IOException) { if (!continuation.isCancelled) continuation.resumeWithException(e) }
    })
}
