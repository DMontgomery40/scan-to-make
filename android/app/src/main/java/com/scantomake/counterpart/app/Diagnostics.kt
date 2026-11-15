package com.scantomake.counterpart.app

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.FileProvider
import com.scantomake.counterpart.api.RecentFailures
import com.scantomake.counterpart.pairing.PairingRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Settings → Share Diagnostics… (#799): a ZIP of what this phone knows about itself, redacted, for a tester to send
 * with a report. The computer's own Export Diagnostics carries the companion's log and the printer software; this is
 * the phone's half. Android keeps no log file of its own, so the ZIP holds the app and phone, the pairing's shape
 * (never its token, pin or address), the last failed requests and the scans on this phone (never their pictures).
 */
object Diagnostics {
    /** One scan recorded on this phone, as its folder says: never its frames. */
    data class Capture(val id: String, val finished: Boolean, val kind: String, val frames: Int, val cameraMetadata: Boolean,
                       val bytes: Long, val projectState: String?)

    data class Input(
        val appVersion: String,
        val versionCode: Long,
        val androidRelease: String,
        val sdk: Int,
        val device: String,
        val nowMs: Long,
        /** The pairing record (read here for its shape only), or null when the phone isn't paired. */
        val pairing: PairingRecord?,
        /** `MacLink` in words: connected, not-answering, checking, needs-pairing (<code>). */
        val link: String,
        val eventsSupported: Boolean?,
        val capabilities: Set<String>,
        val failures: List<RecentFailures.Entry>,
        val captures: List<Capture>,
        /** Values that must never appear: the token, the pin, the device id, the computer's addresses. */
        val secrets: List<String>,
    )

    fun fileName(nowMs: Long): String = "Counterpart Android Diagnostics ${day(nowMs)}.zip"

    /** The ZIP's files, in order, every one redacted. */
    fun files(input: Input): LinkedHashMap<String, String> {
        val out = LinkedHashMap<String, String>()
        val secrets = input.secrets.filter { it.length >= 4 }.distinct().sortedByDescending { it.length }
        fun add(name: String, text: String) { out[name] = redact(text, secrets) }
        add("about.txt", listOf(
            "Counterpart for Android ${input.appVersion} (${input.versionCode})",
            "Android ${input.androidRelease} (API ${input.sdk})",
            "Device: ${input.device}",
            "Exported: ${time(input.nowMs)}",
        ).joinToString("\n", postfix = "\n"))
        add("connection.json", pretty(connection(input)))
        add("request-errors.json", pretty(buildJsonArray {
            input.failures.forEach { f -> add(buildJsonObject {
                put("at", time(f.atMs)); put("method", f.method); put("route", f.route)
                f.status?.let { put("status", it) }; f.code?.let { put("code", it) }
            }) }
        }))
        add("captures.json", pretty(buildJsonArray {
            input.captures.forEach { c -> add(buildJsonObject {
                put("id", c.id); put("finished", c.finished); put("kind", c.kind); put("frames", c.frames)
                put("cameraMetadata", c.cameraMetadata); put("bytes", c.bytes); put("projectState", c.projectState?.let(::JsonPrimitive) ?: JsonNull)
            }) }
        }))
        add("notes.txt", listOf(
            "This phone keeps no log file of its own. request-errors.json lists the requests to the computer that failed since Counterpart last opened (${input.failures.size}).",
            "The computer's own Settings → Advanced → Export Diagnostics… (Mac) or Settings → About → Export Diagnostics… (Linux) has the companion's log and the printer software.",
            "Removed: the pairing token, the computer's pin and addresses, this phone's id and name, e-mail addresses and anything named like a key, code or password.",
        ).joinToString("\n", postfix = "\n"))
        return out
    }

    private fun connection(input: Input): JsonObject = buildJsonObject {
        val record = input.pairing
        put("state", when { record == null -> "not paired"; record.isExpired(input.nowMs) -> "expired"; else -> "paired" })
        put("link", input.link)
        if (record != null) {
            put("trust", when { record.publicKeySha256 != null -> "public key pin"; record.certificateSha256 != null -> "certificate pin"; else -> "system trust (Tailscale)" })
            put("address", addressKind(record.baseUrl))
            put("addressInUse", addressKind(record.activeUrl ?: record.baseUrl))
            put("otherAddresses", buildJsonArray { record.addresses.orEmpty().filter { it != (record.activeUrl ?: record.baseUrl) }.forEach { add(addressKind(it)) } })
            put("renewsBy", time(record.expiresAtMs.toLong()))
            put("daysLeft", ((record.expiresAtMs - input.nowMs) / 86_400_000.0).let { Math.round(it * 10) / 10.0 })
            put("scopes", buildJsonArray { record.scopes.sorted().forEach { add(it) } })
            put("protocolVersion", record.fields["protocolVersion"]?.let { (it as? JsonPrimitive)?.content } ?: "")
        }
        put("eventsLongPoll", input.eventsSupported?.let(::JsonPrimitive) ?: JsonNull)
        put("computerCapabilities", buildJsonArray { input.capabilities.sorted().forEach { add(it) } })
    }

    /** What kind of address, never the address: Tailscale, a local network address or name, or another. */
    fun addressKind(url: String?): String {
        val host = url?.let { try { URI(it).host } catch (_: Exception) { null } }?.lowercase()?.trim('[', ']') ?: return "none"
        val v4 = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""").matchEntire(host)?.groupValues?.drop(1)?.map { it.toInt() }
        return when {
            host.endsWith(".ts.net") -> "Tailscale name"
            v4 != null && v4[0] == 100 && v4[1] in 64..127 -> "Tailscale address (IPv4)"
            v4 != null && (v4[0] == 10 || (v4[0] == 172 && v4[1] in 16..31) || (v4[0] == 192 && v4[1] == 168)) -> "local network address (IPv4)"
            v4 != null && v4[0] == 169 && v4[1] == 254 -> "link-local address (IPv4)"
            v4 != null && v4[0] == 127 -> "loopback address"
            v4 != null -> "other address (IPv4)"
            host.startsWith("fd7a:115c:a1e0") -> "Tailscale address (IPv6)"
            host.contains(':') && (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) -> "link-local address (IPv6)"
            host.contains(':') && (host.startsWith("fc") || host.startsWith("fd")) -> "local network address (IPv6)"
            host.contains(':') -> "other address (IPv6)"
            host.endsWith(".local") -> "local network name (.local)"
            else -> "other name"
        }
    }

    // MARK: Redaction, as the companion's (services/companion/src/diagnostics.ts, PR #813), plus the phone's own words.

    // Names that say a value is a secret, whatever the case or joining. `auth` and `pin` only as words of their own
    // (`AUTH_TOKEN`, `pin=`), so "authenticate", "pinned" and "mapping" keep their words.
    private const val SECRET_WORD = """(?:password|passwd|passcode|pwd|secret|token|api[_-]?key|apikey|access[_-]?code|accesscode|access[_-]?key|authorization|auth(?:[_-]?key)?(?![a-z])|cookie|credential|private[_-]?key|signature|ticket|login|email|user[_-]?info|pin(?![a-z])|pairing[_-]?code|sha256)"""
    private const val SECRET_KEY = """[A-Za-z0-9_.-]*$SECRET_WORD[A-Za-z0-9_.-]*"""
    /** Values that are already safe after a secret's name: "[set]", "[redacted…]", empty, true/false/null. */
    private const val SAFE = """(?!"(?:\[set\]|\[redacted[^"]*\])?"|\[set\]|\[redacted|true\b|false\b|null\b|"")"""
    private val RULES: List<Pair<Regex, String>> = listOf(
        Regex("""-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)""") to "[redacted private key]",
        Regex("""\b([a-z][a-z0-9+.-]*://)[^/\s:@"'<>]+(?::[^/\s@"'<>]*)?@""", RegexOption.IGNORE_CASE) to "$1[redacted]@",
        // Authorization schemes, before the key=value rules: those take "Bearer" as the value and would leave the
        // credential after it ("Authorization: [redacted] <token>", as the companion's order does).
        Regex("""\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}""") to "$1 [redacted]",
        Regex("""(\\"$SECRET_KEY\\"\s*:\s*)\\"(?:[^"\\]|\\[^"])*\\"""", RegexOption.IGNORE_CASE) to "\$1\\\\\"[redacted]\\\\\"",
        Regex("""("$SECRET_KEY"\s*:\s*)$SAFE(?:"(?:[^"\\]|\\.)*"|[^\s,}\]]+)""", RegexOption.IGNORE_CASE) to "$1\"[redacted]\"",
        Regex("""(\b$SECRET_KEY[ \t]*[=:][ \t]*|--$SECRET_KEY[ \t]+)$SAFE(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]"']+)""", RegexOption.IGNORE_CASE) to "$1[redacted]",
        Regex("""^((?:Set-)?Cookie:).*$""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)) to "$1 [redacted]",
        Regex("""\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+""") to "[redacted token]",
        Regex("""\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}""") to "[redacted key]",
        Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}""") to "[redacted email]",
        Regex("""scantomake://pair\?[^\s"']+""") to "scantomake://pair?[redacted]",
        // The phone's own: a 64-hex pin or hash, and a 43-character pairing token, wherever they appear.
        Regex("""\b[a-fA-F0-9]{64}\b""") to "[redacted hash]",
        Regex("""(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])""") to "[redacted token]",
    )

    /** Text with every secret removed: the known values first (longest first), then everything secret-shaped. */
    fun redact(text: String, secrets: List<String> = emptyList()): String {
        var out = text
        for (secret in secrets.filter { it.length >= 4 }.sortedByDescending { it.length }) out = out.replace(secret, "[redacted]")
        for ((pattern, replacement) in RULES) out = pattern.replace(out, replacement)
        return out
    }

    /** A plain ZIP of the files, UTF-8 names. */
    fun zip(files: Map<String, String>, nowMs: Long): ByteArray {
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { zip ->
            for ((name, text) in files) {
                zip.putNextEntry(ZipEntry(name).apply { time = nowMs })
                zip.write(text.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
        }
        return bytes.toByteArray()
    }

    private val pretty = Json { prettyPrint = true }
    private fun pretty(element: JsonElement) = pretty.encodeToString(JsonElement.serializer(), element) + "\n"
    private fun time(ms: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))
    private fun day(ms: Long) = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(ms))

    // MARK: On the phone

    /** The scans in this phone's Captures folder, with their project's state when the list has it. */
    fun captures(context: Context, projectStates: Map<String, String>): List<Capture> =
        File(context.filesDir, "Captures").listFiles { f -> f.isDirectory }?.sortedBy { it.name }?.map { folder ->
            val id = folder.name
            Capture(id, Media.captureFinished(context, id), Media.captureKind(context, id), Media.captureFrames(context, id).size,
                File(folder, "capture-camera.json").exists(), folder.walkTopDown().filter { it.isFile }.sumOf { it.length() }, projectStates[id])
        } ?: emptyList()

    /** Reads this phone's state now. */
    fun input(app: Counterpart, nowMs: Long = System.currentTimeMillis()): Input {
        val state = app.state
        val record = try { app.pairingStore.read() } catch (_: Exception) { null }
        val info = try { app.packageManager.getPackageInfo(app.packageName, 0) } catch (_: Exception) { null }
        val code = info?.let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else @Suppress("DEPRECATION") it.versionCode.toLong() } ?: 0L
        val link = when (val l = state.link.value) {
            is com.scantomake.counterpart.api.MacLink.NeedsPairing -> "needs pairing (${l.code})"
            com.scantomake.counterpart.api.MacLink.Connected -> "connected"
            com.scantomake.counterpart.api.MacLink.NotAnswering -> "not answering"
            else -> "checking"
        }
        // The names the person chose (this phone's, the computer's) are never written at all, so they aren't listed:
        // a phone named "Pixel 8" would otherwise hide its own model in about.txt.
        val secrets = listOfNotNull(record?.token, record?.deviceId, record?.publicKeySha256, record?.certificateSha256) +
            listOfNotNull(record?.baseUrl, record?.activeUrl).plus(record?.addresses.orEmpty()).mapNotNull { try { URI(it).host } catch (_: Exception) { null } }
        return Input(
            appVersion = info?.versionName ?: "unknown", versionCode = code,
            androidRelease = Build.VERSION.RELEASE ?: "unknown", sdk = Build.VERSION.SDK_INT,
            device = app.deviceModel() ?: "unknown", nowMs = nowMs, pairing = record, link = link,
            eventsSupported = state.eventsSupported.value, capabilities = state.capabilities.value,
            failures = app.failures.list(),
            captures = captures(app, state.projects.value.associate { it.id to it.state.wire }),
            secrets = secrets,
        )
    }

    /** Writes the ZIP into the cache and opens the share sheet for it. */
    suspend fun share(context: Context, app: Counterpart) {
        val now = System.currentTimeMillis()
        val file = withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "Diagnostics").apply { deleteRecursively(); mkdirs() }
            File(folder, fileName(now)).apply { writeBytes(zip(files(input(app, now)), now)) }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, file.nameWithoutExtension)
            clipData = ClipData.newRawUri(file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(send, "Share Diagnostics").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
