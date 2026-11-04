package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.encodeQueryValue
import java.io.File
import java.util.Collections

/** One file to send to a project: a scan model, a photo, or a capture frame. Port of CounterpartKit `UploadFile`. */
data class UploadFile(val kind: Kind, val name: String, val file: File? = null, val bytes: ByteArray? = null, val type: String) {
    enum class Kind { Scan, Photo, Capture, Depth }

    companion object {
        fun image(file: File, name: String = file.name, kind: Kind = Kind.Photo): UploadFile {
            val ext = file.extension.lowercase()
            val type = when (ext) { "heic" -> "image/heic"; "png" -> "image/png"; else -> "image/jpeg" }
            return UploadFile(kind, name, file = file, type = type)
        }
    }
}

/** Sends files to a project, skipping what the Mac already has, so a send cut short can simply run again. */
class ProjectUploader(private val client: CompanionClient) {
    private val sending = Collections.synchronizedSet(HashSet<String>())

    fun isSending(projectId: String) = projectId in sending

    /** Sends whatever of `files` the Mac doesn't have yet, stopping at the first failure. Returns photos/frames sent. */
    suspend fun send(files: List<UploadFile>, projectId: String, forMessage: Boolean = false, scanName: String = "scan.usdz"): Int {
        if (!sending.add(projectId)) throw CompanionException("busy", "This is already being sent.")
        try {
            val project = client.get(projectId)
            val photos = project.photos.toSet()
            val captured = (project.capture ?: emptyList()).toSet()
            val depths = (project.captureDepth ?: emptyList()).toSet()
            val missing = files.filter { f ->
                when (f.kind) {
                    UploadFile.Kind.Scan -> project.scan == null
                    UploadFile.Kind.Photo -> f.name !in photos
                    UploadFile.Kind.Capture -> f.name !in captured
                    UploadFile.Kind.Depth -> f.name !in depths
                }
            }
            var sent = 0
            for (f in missing) {
                val bytes = f.bytes ?: try { f.file?.readBytes() } catch (_: Exception) { null }
                val limit = when (f.kind) {
                    UploadFile.Kind.Scan -> CompanionClient.SCAN_LIMIT
                    UploadFile.Kind.Depth -> CompanionClient.DEPTH_LIMIT
                    else -> CompanionClient.PHOTO_LIMIT
                }
                if (bytes == null || bytes.isEmpty() || bytes.size > limit) throw CompanionException("unreadable-file", "A file from this scan couldn't be read.")
                val method: String
                val path: String
                if (f.kind == UploadFile.Kind.Scan) {
                    method = "PUT"
                    path = "/v1/objects/$projectId/scan" + if (scanName != "scan.usdz") "?name=$scanName" else ""
                } else {
                    val route = when (f.kind) { UploadFile.Kind.Depth -> "capture-depth"; UploadFile.Kind.Capture -> "capture"; else -> "photos" }
                    method = "POST"
                    path = "/v1/objects/$projectId/$route?name=${encodeQueryValue(f.name)}" + if (f.kind == UploadFile.Kind.Photo && forMessage) "&forMessage=true" else ""
                }
                val reply = client.send(method, path, bytes, f.type)
                if (reply.status == 409) throw CompanionException("conflict", "This is already being touched up.")
                if (reply.status !in 200..299) {
                    throw if (reply.status == 404) CompanionException("not-found", "This is no longer on your computer.")
                    else CompanionException("upload-failed", "Your computer didn't accept a file from this scan. Try again.")
                }
                if (f.kind != UploadFile.Kind.Scan) sent += 1
            }
            return sent
        } finally { sending.remove(projectId) }
    }

    companion object {
        /** Evenly spread picks from first to last, so every side of the object stays represented. */
        fun <T> spread(items: List<T>, count: Int): List<T> {
            if (items.size <= count || count <= 1) return items.take(maxOf(count, 0))
            return (0 until count).map { items[Math.round(it.toDouble() * (items.size - 1) / (count - 1)).toInt()] }
        }
    }
}
