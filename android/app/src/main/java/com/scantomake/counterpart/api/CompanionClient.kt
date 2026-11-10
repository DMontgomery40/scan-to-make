package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.bool
import com.scantomake.counterpart.core.encodePath
import com.scantomake.counterpart.core.encodeQueryValue
import com.scantomake.counterpart.core.encodeURIComponent
import com.scantomake.counterpart.core.jsonOf
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.net.HttpRequest
import com.scantomake.counterpart.net.HttpTransport
import com.scantomake.counterpart.net.TransportException
import com.scantomake.counterpart.net.TrustPolicy
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingRecord
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import java.io.File

/** A refusal in one sentence a screen can show as it is. Port of CounterpartKit `CompanionError`. */
class CompanionException(val code: String, override val message: String) : Exception(message) {
    val needsPairing: Boolean get() = code in setOf("pairing-required", "pairing-changed", "certificate-changed", "scope-denied", "pairing")
    val isUnreachable: Boolean get() = code == "unreachable"
    val isUnsupported: Boolean get() = code == "not-supported"

    companion object {
        val unreachable get() = CompanionException("unreachable", "Your computer isn't answering. Check it's on and awake, then try again.")
        val cancelled get() = CompanionException("cancelled", "Cancelled.")
        val unsupported get() = CompanionException("not-supported", "Update Counterpart on your computer to use this here.")

        fun transport(code: String): CompanionException = when (code) {
            "pairing-required", "scope-denied", "pairing-changed" -> CompanionException(code, "Connect to your computer again.")
            "certificate-changed" -> CompanionException(code, "Your computer presented a different certificate. Scan a new QR code from it.")
            "too-large", "payload-too-large" -> CompanionException("payload-too-large", "That file is too large to send.")
            "invalid-request" -> CompanionException(code, "That request isn't allowed.")
            "cancelled" -> cancelled
            "network", "timeout", "certificate", "unreachable" -> unreachable
            else -> CompanionException(code, "Something went wrong talking to your computer. Try again.")
        }
    }
}

/**
 * The companion's phone API (docs/protocols/objects-api.md), over the paired, pinned connection. Port of
 * CounterpartKit `CompanionClient`: every request carries the device token and is pinned like pairing.
 */
class CompanionClient(
    val pairing: PairingClient,
    private val transport: HttpTransport,
    deviceModel: String?,
    deviceName: String?,
    val cache: File,
) {
    /** `X-Scan-Device-Model`: the hardware model ("Pixel 8"), shown in the Mac's device list. */
    val deviceModel: String? = deviceModel?.takeIf { Pattern("[A-Za-z0-9,._ -]{1,64}").matches(it) }
    /** `X-Scan-Device-Name`: the phone's own name, percent-encoded as encodeURIComponent does. */
    val deviceName: String? = deviceName?.takeIf { it.length <= 80 }?.let(::encodeURIComponent)

    companion object {
        /** The companion may slice an estimate for 600 s (630 s with what it reads first): wait a little longer. */
        const val ESTIMATE_TIMEOUT_MS = 640_000L
        const val JSON_LIMIT = 4 * 1024 * 1024
        const val SCAN_LIMIT = 64 * 1024 * 1024
        const val PHOTO_LIMIT = 25 * 1024 * 1024
        const val DEPTH_LIMIT = 8 * 1024 * 1024
        const val UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"

        /** The scope a route needs (its path without the query), or null when the phone never calls it. */
        fun scope(method: String, path: String): String? {
            val one = "/v1/objects/$UUID"
            fun m(pattern: String) = Pattern(pattern).matches(path)
            when (method) {
                "GET" -> {
                    if (path == "/v1/printers/mcps") return "projects:read"
                    if (path == "/v1/blender") return "projects:read"
                    if (m("/v1/objects(?:/printers)?") || m(one) || m("$one/passes/(0|[1-9][0-9]{0,15})/activity")) return "projects:read"
                    if (m("/healthz")) return "generation:health"
                    if (m("/v1/events") || m("/v1/settings") || m("/v1/settings/cad") || m("/v1/devices")) return "projects:read"
                    if (m("$one/(model\\.stl|reconstruction-preview\\.stl|renders/[^/]+|photos/[^/]+|capture/[^/]+|scan/[^/]+|original/[0-9]+|asks/[^/]+|prints/[^/]+/frames/[^/]+)")) return "projects:read"
                    if (m("$one/(filaments|colour-mapping|camera\\.jpg)") || m("/v1/objects/printers/[^/]+/camera\\.jpg")) return "printer-handoff:use"
                    if (m("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/route")) return "printer-handoff:use"
                }
                "PATCH" -> {
                    if (m(one)) return "captures:import"
                    if (m("$one/settings")) return "captures:import"
                    if (m("/v1/settings")) return "projects:write"
                }
                "DELETE" -> {
                    if (m(one)) return "captures:import"
                    if (m("/v1/devices/[^/]+")) return "projects:write"
                }
                "PUT" -> if (m("$one/scan")) return "captures:import"
                "POST" -> {
                    if (m("/v1/blender/(check|update)")) return "projects:write"
                    if (m("/v1/objects") || m("$one/(start|duplicate|corrections|closeup|model|ask|plate-selection|photos|capture|capture-depth|capture-camera|reconstruction)")) return "captures:import"
                    if (m("$one/(print|printer|print-confirmation|estimate|print/pause|print/resume|print/cancel)")) return "printer-handoff:use"
                    if (m("/v1/devices/live-activity-tokens")) return "projects:write"
                    if (m("/v1/settings/(ai/test|fusion/setup|cad/setup)")) return "projects:write"
                    if (m("/v1/printers/mcp/mcp-[0-9a-f]{16}/update")) return "projects:write"
                    if (m("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/route")) return "printer-handoff:use"
                    if (m("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/mcp")) return "projects:write"
                    // Add printer (the computer also checks printing, `printer-handoff:use`; every phone pairing has both).
                    if (m("/v1/printers/setup/(discover|check|obtain|add)")) return "projects:write"
                }
            }
            return null
        }

        /** The Mac's refusal in plain words. A 409's message is written for the person, so it's shown as is. */
        fun refusal(reply: HttpReply, path: String): CompanionException {
            val error = parseObject(reply.body)?.get("error").obj
            val message = error?.get("message").str
            val code = error?.get("code").str
            val newer = path.startsWith("/v1/events") || path.startsWith("/v1/settings") || path.endsWith("/camera.jpg") || path.contains("/print/") ||
                path.endsWith("/estimate") || path.contains("/asks/") || path.startsWith("/v1/devices") || path.endsWith("/settings") ||
                path.startsWith("/v1/printers/") || path.startsWith("/v1/objects/printers/") ||
                path.endsWith("/capture-camera") || path.endsWith("/reconstruction") || path.contains("/reconstruction-preview")
            return when {
                reply.status == 401 || reply.status == 403 -> CompanionException("pairing", "Connect to your computer again.")
                reply.status == 404 && path == "/v1/objects" -> CompanionException("not-set-up", "Your computer isn't ready to make things yet. Open Counterpart on your computer.")
                reply.status == 404 && path.endsWith("/filaments") -> CompanionException("not-set-up", "Update Counterpart on your computer to choose a filament here.")
                reply.status == 404 && path.endsWith("/camera.jpg") && code == "not-found" && message?.contains("camera") == true ->
                    CompanionException("no-camera", "This printer has no camera Counterpart can use.")
                reply.status == 404 && (newer || code == "method-not-allowed") -> CompanionException.unsupported
                reply.status == 405 -> CompanionException.unsupported
                // The computer's own sentence, whatever the status, when it says it's written for the person (Nov 6).
                !error?.get("sentence").str.isNullOrBlank() -> CompanionException(code ?: "refused", error?.get("sentence").str!!)
                reply.status == 404 -> CompanionException("not-found", "This is no longer on your computer.")
                reply.status == 409 -> CompanionException("conflict", message ?: "Wait until the current step finishes.")
                reply.status == 503 -> CompanionException("unavailable", if (path.endsWith("/camera.jpg")) "The printer's camera isn't answering right now."
                    else "The printer isn't answering right now. Try again in a moment.")
                // Reconstruction answers and camera metadata carry sentences written for the person
                // (a stale preview, a mismatched capture): show them as they are.
                reply.status == 400 && message != null && (path.endsWith("/reconstruction") || path.endsWith("/capture-camera")) ->
                    CompanionException("invalid-answer", message)
                reply.status == 400 && code == "invalid-request" -> CompanionException("invalid-request", "Your computer didn't accept that. Update Counterpart on your computer, then try again.")
                else -> CompanionException("failed", "Something went wrong on your computer. Try again.")
            }
        }
    }

    private fun record(scope: String): PairingRecord {
        val record = try { pairing.store.read() } catch (_: Exception) { throw CompanionException.transport("pairing-required") }
        if (record == null || record.requestBaseURL == null || record.isExpired()) throw CompanionException.transport("pairing-required")
        if (!record.has(scope)) throw CompanionException.transport("scope-denied")
        return record
    }

    /** One request: pinned, size-limited, and refused afterwards if the pairing changed while it ran. */
    suspend fun send(method: String, path: String, body: ByteArray? = null, contentType: String = "application/json",
                     limit: Int = JSON_LIMIT, timeoutMs: Long = 90_000, ifNoneMatch: String? = null): HttpReply {
        val scope = scope(method, path.substringBefore("?")) ?: throw CompanionException.transport("invalid-request")
        var attempt = record(scope)
        for (retry in 0..1) {
            val base = attempt.requestBaseURL
            val token = attempt.token
            val device = attempt.deviceId
            if (base == null || token == null || device == null) throw CompanionException.transport("invalid-request")
            val headers = LinkedHashMap<String, String>()
            ifNoneMatch?.let { headers["If-None-Match"] = it }
            headers["Authorization"] = "Bearer $token"
            headers["X-Scan-Device"] = device
            deviceModel?.let { headers["X-Scan-Device-Model"] = it }
            deviceName?.let { headers["X-Scan-Device-Name"] = it }
            val request = HttpRequest(method, base + path, headers, body, if (body != null) contentType else null, timeoutMs)
            try {
                val resource = if ((body?.size ?: 0) > PHOTO_LIMIT) 600_000 else maxOf(180_000, timeoutMs + 10_000)
                val reply = transport.send(request, TrustPolicy.Record(attempt), limit, resource)
                val latest = try { pairing.store.read() } catch (_: Exception) { null }
                if (!attempt.isSamePairing(latest)) throw CompanionException.transport("pairing-changed")
                return reply
            } catch (e: TransportException) {
                // A GET that can't reach the Mac checks its other addresses once, moving to whichever answers.
                if (retry == 0 && method == "GET" && !path.startsWith("/v1/events") && e.code in setOf("network", "timeout") && (attempt.addresses?.size ?: 0) > 1) {
                    val checked = try { pairing.check() } catch (_: Exception) { null }
                    val moved = try { record(scope) } catch (_: Exception) { null }
                    if (checked != null && checked.activeUrl != attempt.activeUrl && moved != null) { attempt = moved; continue }
                }
                throw CompanionException.transport(e.code)
            }
        }
        throw CompanionException.unreachable
    }

    /** A JSON request and its decoded reply object, with the Mac's refusals in plain words. */
    suspend fun request(method: String, path: String, json: JsonObject? = null, timeoutMs: Long = 90_000): JsonObject {
        var body: ByteArray? = null
        if (json != null) {
            val data = WireJson.encodeToString(JsonObject.serializer(), json).toByteArray()
            val start = method == "POST" && path.endsWith("/start")
            if (data.size > (if (start) 128 * 1024 else 16 * 1024)) throw CompanionException.transport("invalid-request")
            body = data
        }
        val reply = send(method, path, body, timeoutMs = timeoutMs)
        return decode(reply, path)
    }

    private fun decode(reply: HttpReply, path: String): JsonObject {
        if (reply.status in 200..299) {
            return parseObject(reply.body) ?: throw CompanionException("invalid-response", "Your computer sent something this app doesn't understand. Update both apps.")
        }
        throw refusal(reply, path)
    }

    private fun invalid() = CompanionException("invalid-response", "Your computer sent something this app doesn't understand. Update both apps.")
    private fun one(o: JsonObject): Project = o["object"].obj?.let(Project::decode) ?: throw invalid()
    private fun HttpReply.checked(path: String): HttpReply { if (status !in 200..299) throw refusal(this, path); return this }

    // MARK: Projects

    suspend fun list(): List<Project> = request("GET", "/v1/objects")["objects"].arr?.mapNotNull { it.obj?.let(Project::decode) } ?: throw invalid()
    suspend fun get(id: String): Project = one(request("GET", "/v1/objects/$id"))

    suspend fun addStarter(starterId: String): Project = one(request("POST", "/v1/objects", jsonOf("starterId" to starterId)))

    suspend fun selectPlate(id: String, fileIndex: Int, plateIndex: Int): Project =
        one(request("POST", "/v1/objects/$id/plate-selection", jsonOf("fileIndex" to fileIndex, "plateIndex" to plateIndex)))

    /** Creates a project. `kind` is `fit`, `copy` or `published` (with a model page `url`). */
    suspend fun create(instructions: String, kind: String? = null, url: String? = null, fit: ProjectFit? = null): Project =
        one(request("POST", "/v1/objects", createBody(instructions, kind, url, fit)))

    /** A draft's fit choice is sent every time: the fields, or null when the draft is no longer a fit. */
    suspend fun updateDraft(id: String, instructions: String, kind: String? = null, fit: ProjectFit? = null): Project =
        one(request("PATCH", "/v1/objects/$id", draftBody(instructions, kind, fit)))

    suspend fun start(id: String, captureManifest: JsonObject? = null): Project =
        one(request("POST", "/v1/objects/$id/start", if (captureManifest != null) jsonOf("captureManifest" to captureManifest) else JsonObject(emptyMap())))
    /** Ask for changes: a new pass with your text. Upload new photos first. */
    /** [messageId] is this note's own id ([NoteAttempt]): the Mac records a note once per id. */
    suspend fun correct(id: String, note: String, photoNames: List<String>? = null, messageId: String? = null): Project =
        one(request("POST", "/v1/objects/$id/corrections", jsonOf("note" to note, "photoNames" to photoNames, "messageId" to messageId)))
    /** Answers the open Ask with uploaded photos, a best guess, or words. */
    suspend fun answerAsk(id: String, bestGuess: Boolean = false, text: String? = null, photoNames: List<String> = emptyList()): Project {
        val json = LinkedHashMap<String, Any?>()
        if (bestGuess) json["bestGuess"] = true
        text?.let { json["text"] = it }
        json["photoNames"] = photoNames
        return one(request("POST", "/v1/objects/$id/closeup", com.scantomake.counterpart.core.toJson(json) as JsonObject))
    }
    suspend fun choosePublishedPlate(id: String, askId: String, choice: String): Project =
        one(request("POST", "/v1/objects/$id/ask", jsonOf("askId" to askId, "choices" to listOf(choice))))
    suspend fun addModelFile(id: String, name: String, bytes: ByteArray): Project {
        if (bytes.isEmpty() || bytes.size > 64 * 1024 * 1024 || name.substringAfterLast('.').lowercase() !in setOf("3mf", "stl")) {
            throw CompanionException("invalid-model", "Choose a 3MF or STL file at most 64 MB.")
        }
        val path = "/v1/objects/$id/model?name=${encodeQueryValue(name)}"
        val reply = send("POST", path, bytes, "application/octet-stream").checked(path)
        return one(parseObject(reply.body) ?: throw invalid())
    }
    /** Project Settings: status, archived or title. Returns the project when the Mac sends it back. */
    suspend fun changeProjectSettings(id: String, patch: JsonObject): Project? {
        val path = "/v1/objects/$id/settings"
        val reply = send("PATCH", path, WireJson.encodeToString(JsonObject.serializer(), patch).toByteArray()).checked(path)
        return parseObject(reply.body)?.get("object").obj?.let(Project::decode)
    }
    suspend fun setStatus(id: String, status: ProjectStatus) = changeProjectSettings(id, jsonOf("status" to status.wire))
    suspend fun setArchived(id: String, archived: Boolean) = changeProjectSettings(id, jsonOf("archived" to archived))
    suspend fun rename(id: String, title: String) = changeProjectSettings(id, jsonOf("title" to title))
    suspend fun duplicate(id: String) = one(request("POST", "/v1/objects/$id/duplicate", JsonObject(emptyMap())))

    /**
     * capture-camera v1 for the frames already uploaded (`POST …/capture-camera`, ≤ 4 MiB). Sent as raw
     * bytes: 150 frames exceed the small-JSON cap in [request]. The companion binds every frame to the
     * exact saved photo bytes and refuses a mismatch in words.
     */
    suspend fun addCaptureCamera(id: String, json: ByteArray): Project {
        if (json.isEmpty() || json.size > 4 * 1024 * 1024)
            throw CompanionException("invalid-capture-camera", "This scan's camera information couldn't be sent. Scan it again.")
        val path = "/v1/objects/$id/capture-camera"
        val reply = send("POST", path, json, "application/json").checked(path)
        return one(parseObject(reply.body) ?: throw invalid())
    }

    /** The current reconstruction review's preview STL (≤ 64 MiB), only ever by its exact review id. */
    suspend fun reconstructionPreview(id: String, reviewId: String): ByteArray {
        if (!Pattern("[0-9a-f-]{36}", caseInsensitive = true).matches(reviewId))
            throw CompanionException("invalid-review", "That question has been answered or replaced. Look again.")
        val path = "/v1/objects/$id/reconstruction-preview.stl?reviewId=${encodeQueryValue(reviewId)}"
        val reply = send("GET", path, limit = SCAN_LIMIT).checked(path.substringBefore("?"))
        if (reply.body.isEmpty()) throw CompanionException("download-failed", "The rebuilt model couldn't be loaded. Try again.")
        return reply.body
    }

    /** The explicit reconstruction answer, bound to the open review's id and hashes. */
    suspend fun answerReconstruction(id: String, reviewId: String, answer: JsonObject): Project =
        one(request("POST", "/v1/objects/$id/reconstruction", jsonOf("reviewId" to reviewId, "answer" to answer)))
    suspend fun delete(id: String) { request("DELETE", "/v1/objects/$id") }
    suspend fun passActivity(id: String, index: Int): List<Project.Activity> =
        request("GET", "/v1/objects/$id/passes/$index/activity").opt<List<Project.Activity>>("activity") ?: emptyList()

    // MARK: Health and printing

    data class Health(val capabilities: Set<String>, val name: String?)

    /** A quick "are you there?": `/healthz` with a short timeout. */
    suspend fun answers(): Boolean = try { send("GET", "/healthz", timeoutMs = 6_000).checked("/healthz"); true } catch (_: Exception) { false }

    suspend fun health(): Health {
        val o = request("GET", "/healthz")
        val caps = o["capabilities"].obj?.filter { it.value.bool == true }?.keys ?: emptySet()
        val name = (o["name"].str ?: o["macName"].str)?.trim()?.takeIf { it.isNotEmpty() }
        return Health(caps, name)
    }

    suspend fun printers(): PrinterCatalog = WireJson.decodeFromJsonElement(request("GET", "/v1/objects/printers"))
    suspend fun filaments(id: String): List<PrinterFilament> = request("GET", "/v1/objects/$id/filaments").opt<List<PrinterFilament>>("filaments") ?: emptyList()
    suspend fun colourMapping(id: String): ColourMapping = WireJson.decodeFromJsonElement(request("GET", "/v1/objects/$id/colour-mapping"))
    suspend fun selectPrinter(id: String, destinationId: String) = one(request("POST", "/v1/objects/$id/printer", jsonOf("destinationId" to destinationId)))

    /**
     * Slices exactly what Print would send with these choices: time, grams, layers, and the printer MCP's pictures
     * of that file. Print then sends its `sliceSha256`. Can take up to 150 s.
     */
    suspend fun estimate(id: String, destinationId: String?, choice: PrintChoice): SliceEstimate =
        WireJson.decodeFromJsonElement(request("POST", "/v1/objects/$id/estimate", choice.estimateBody(destinationId), timeoutMs = ESTIMATE_TIMEOUT_MS))

    /** Starts preparing the print. The printer MCP still asks its own confirmation. */
    suspend fun print(id: String, choice: PrintChoice, expectedPlate: String? = null): Project {
        val body = if (expectedPlate == null) choice.body else JsonObject(choice.body + ("expectedPlate" to JsonPrimitive(expectedPlate)))
        return one(request("POST", "/v1/objects/$id/print", body))
    }
    suspend fun answerPrintConfirmation(id: String, response: JsonObject): Project = one(request("POST", "/v1/objects/$id/print-confirmation", response))

    enum class PrintControl(val wire: String) { Pause("pause"), Resume("resume"), Cancel("cancel") }
    /** Pause, resume or stop a running print. Older Macs answer `not-supported`. */
    suspend fun control(id: String, action: PrintControl): Project = one(request("POST", "/v1/objects/$id/print/${action.wire}", JsonObject(emptyMap())))

    class CameraFrame(val jpeg: ByteArray, val capturedAtMs: Long?, val etag: String?)

    /** A camera snapshot of the project's printer (ETag-aware), as the iPhone app's snapshot fallback reads it. */
    suspend fun camera(projectId: String? = null, destinationId: String? = null, fullScreen: Boolean = false, previous: CameraFrame? = null): CameraFrame {
        val path = if (projectId != null) "/v1/objects/$projectId/camera.jpg"
            else "/v1/objects/printers/${encodeURIComponent(destinationId ?: "")}/camera.jpg"
        val reply = send("GET", path + if (fullScreen) "?size=full" else "", limit = PHOTO_LIMIT, timeoutMs = 20_000, ifNoneMatch = previous?.etag)
        if (reply.status == 304 && previous != null) return previous
        if (reply.status != 200) throw refusal(reply, path)
        if (reply.body.isEmpty()) throw CompanionException("unavailable", "The printer's camera isn't answering right now.")
        return CameraFrame(reply.body, Iso.parse(reply.header("X-Captured-At")), reply.header("ETag"))
    }

    // MARK: Settings, devices and events

    suspend fun settings(): JsonObject = request("GET", "/v1/settings")["settings"].obj ?: throw invalid()
    suspend fun changeSettings(patch: JsonObject): JsonObject = request("PATCH", "/v1/settings", patch)["settings"].obj ?: throw invalid()
    /** Settings → the code design engine's row, read fresh (the plain settings read never starts the printer MCP). */
    suspend fun codeEngine(): JsonObject? = request("GET", "/v1/settings/cad")["cad"].obj
    /** Settings → the code design engine's Set Up (PRD §8.9): the computer starts the printer MCP's cad_setup and returns at once. */
    suspend fun setUpCodeEngine(): JsonObject = request("POST", "/v1/settings/cad/setup", jsonOf())["settings"].obj ?: throw invalid()
    suspend fun devices(): List<JsonObject> = request("GET", "/v1/devices")["devices"].arr?.mapNotNull { it.obj } ?: emptyList()

    suspend fun events(after: Int, wait: Int, limit: Int): EventsPage {
        val o = request("GET", "/v1/events?after=${maxOf(0, after)}&wait=${wait.coerceIn(0, 25)}&limit=${limit.coerceIn(0, 500)}", timeoutMs = 40_000)
        return EventsPage.decode(o) ?: throw invalid()
    }

    // MARK: Files

    private val allowed = Pattern("""original/[0-9]+|model\.stl|renders/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png|asks/[a-f0-9-]{36}\.(jpg|png)|prints/[a-f0-9-]{36}/frames/[a-f0-9-]{36}\.jpg|(?:photos|capture|scan)/[A-Za-z0-9][A-Za-z0-9._ -]{0,127}""")

    /** Downloads one project file into the cache, once per project version, and returns where it is. */
    suspend fun download(project: Project, name: String): File {
        if (!Pattern(UUID).matches(project.id) || !allowed.matches(name) || name.contains("..")) throw CompanionException.transport("invalid-request")
        val version = project.mediaVersion.toString()
        val folder = File(File(cache, project.id), version)
        var filename = name.replace("/", "_")
        var resource = name
        if (name == "model.stl" && project.kind == "published") {
            val model = project.current?.model
            if (model != null) {
                val threeMf = model.lowercase().endsWith(".3mf")
                filename = "model-${Hex.sha256(model.toByteArray())}.${if (threeMf) "3mf" else "stl"}"
                val originals = project.files?.get("original").arr
                val index = originals?.indexOfFirst { it.str == model } ?: -1
                if (index >= 0) resource = "original/$index"
            }
        }
        val target = File(folder, filename)
        if (target.exists()) return target
        val path = "/v1/objects/${project.id}/${encodePath(resource)}"
        val reply = send("GET", path, limit = SCAN_LIMIT)
        if (reply.status != 200 || reply.body.isEmpty()) {
            throw if (reply.status == 404) CompanionException("not-found", "This is no longer on your computer.")
            else CompanionException("download-failed", "That file couldn't be saved on this phone.")
        }
        // Older versions of this project are no longer shown.
        folder.parentFile?.listFiles()?.filter { it.name != version }?.forEach { it.deleteRecursively() }
        folder.mkdirs()
        val temp = File(folder, "$filename.part")
        try { temp.writeBytes(reply.body); temp.renameTo(target) } catch (_: Exception) {
            throw CompanionException("download-failed", "That file couldn't be saved on this phone.")
        }
        return target
    }
}
