package com.scantomake.counterpart.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectUploader
import com.scantomake.counterpart.api.ReconstructionAnswers
import com.scantomake.counterpart.api.UploadFile
import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.scan.CaptureCamera
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Photos chosen or taken for a project stay in the cache (ObjectsChosen) until the Mac has them. */
object Media {
    /** Bound allocation before reading a document; import original 3MFs without modifying them. */
    fun readModel(context: Context, uri: Uri): Pair<String, ByteArray> {
        val name = context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(cursor.getColumnIndexOrThrow("_display_name")) else null
        } ?: throw CompanionException("invalid-model", "That file's name couldn't be read.")
        if (name.substringAfterLast('.').lowercase() !in setOf("3mf", "stl"))
            throw CompanionException("invalid-model", "Choose an original 3MF or STL file.")
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size().toLong() + count > 64L * 1024 * 1024)
                    throw CompanionException("invalid-model", "Choose a 3MF or STL file at most 64 MB.")
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: throw CompanionException("invalid-model", "That file couldn't be read.")
        return name to bytes
    }
    fun chosenRoot(context: Context) = File(context.cacheDir, "ObjectsChosen").apply { mkdirs() }

    /** A file the camera app writes a photo into, and its content URI. */
    fun newPhotoTarget(context: Context): Pair<File, Uri> {
        val file = File(chosenRoot(context), "${UUID.randomUUID()}.jpg")
        return file to FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }

    /**
     * Keeps a picked photo as JPEG or PNG (what the Mac takes besides HEIC). A JPEG or PNG under the Mac's
     * 25 MB limit is kept byte for byte (EXIF and all); anything else is decoded and saved as JPEG.
     */
    fun keep(context: Context, uri: Uri): File? = try {
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        val jpeg = bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        val png = bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte()
        if ((jpeg || png) && bytes.size <= CompanionClient.PHOTO_LIMIT) {
            File(chosenRoot(context), "${UUID.randomUUID()}.${if (png) "png" else "jpg"}").apply { writeBytes(bytes) }
        } else {
            val bitmap = if (Build.VERSION.SDK_INT >= 28) ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))) { d, info, _ ->
                val side = maxOf(info.size.width, info.size.height)
                if (side > 4032) d.setTargetSampleSize(side / 4032 + 1)
            } else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            bitmap?.let { b ->
                val out = ByteArrayOutputStream(); b.compress(Bitmap.CompressFormat.JPEG, 90, out)
                File(chosenRoot(context), "${UUID.randomUUID()}.jpg").apply { writeBytes(out.toByteArray()) }
            }
        }
    } catch (_: Exception) { null }

    // MARK: Scans (captures) recorded on this phone

    fun captureFolder(context: Context, projectId: String) = File(File(context.filesDir, "Captures"), projectId)
    fun captureFinished(context: Context, projectId: String) = File(captureFolder(context, projectId), "finished").exists()
    fun captureFrames(context: Context, projectId: String): List<File> =
        captureFolder(context, projectId).listFiles { f -> Regex("[0-9]{4}\\.jpg").matches(f.name) }?.sortedBy { it.name } ?: emptyList()
    /** "ar" (ARCore, with capture-camera.json) or "photos" (timed plain photos); older scans guess from files. */
    fun captureKind(context: Context, projectId: String): String =
        File(captureFolder(context, projectId), "capture-kind").takeIf { it.exists() }?.readText()?.trim()?.takeIf { it == "ar" || it == "photos" }
            ?: if (File(captureFolder(context, projectId), "capture-camera.json").exists()) "ar" else "photos"

    /**
     * The stored capture-camera document, re-verified against the frame files on disk right now: same
     * frame set, same SHA-256, same saved size for every frame. Anything else is an actionable error —
     * never a silently re-bound document. Returns the exact wire bytes to send.
     */
    private suspend fun verifiedCaptureCamera(context: Context, id: String, frames: List<File>): ByteArray = withContext(Dispatchers.IO) {
        val changed = CompanionException("capture-changed", "This scan's files changed on this phone. Scan it again.")
        val file = File(captureFolder(context, id), "capture-camera.json")
        val bytes = try { file.readBytes() } catch (_: Exception) {
            throw CompanionException("capture-camera-missing", "This scan is missing its camera information. Scan it again.")
        }
        if (bytes.isEmpty() || bytes.size > 4 * 1024 * 1024) throw changed
        val records = CaptureCamera.parse(bytes) ?: throw changed
        if (records.map { it.image }.sorted() != frames.map { it.name }.sorted()) throw changed
        val byName = frames.associateBy { it.name }
        for (record in records) {
            val frame = byName[record.image] ?: throw changed
            val data = try { frame.readBytes() } catch (_: Exception) { throw changed }
            if (data.isEmpty() || Hex.sha256(data) != record.sha256) throw changed
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
            if (bounds.outWidth != record.width || bounds.outHeight != record.height) throw changed
        }
        WireJson.encodeToString(JsonObject.serializer(), CaptureCamera.document(records)).toByteArray()
    }

    /**
     * Sends a finished scan and starts the project. The host must first prove it can qualify a photo
     * reconstruction (`/healthz` `reconstructionReviewV1`); an older host gets an update instruction, never
     * a silent downgrade. Frames go up exactly as recorded (re-sent on retry, never skipped by name),
     * then capture-camera v1 for AR captures, then `start` with the capture manifest
     * (`cameraMetadataRequired` for AR, `scaleQualificationRequired` for every Android capture).
     * The recorded frames stay on this phone afterwards, so any step can simply be sent again.
     */
    suspend fun sendProject(context: Context, uploader: ProjectUploader, client: CompanionClient, id: String, photos: List<File>): Project {
        val frames = if (captureFinished(context, id)) captureFrames(context, id) else emptyList()
        if (frames.isEmpty()) {
            sendPhotos(uploader, id, photos)
            return client.start(id)
        }
        ReconstructionAnswers.hostRefusal({ client.health() }, { kotlinx.coroutines.delay(it) })?.let { throw it }
        val ar = captureKind(context, id) == "ar"
        val cameraJson = if (ar) verifiedCaptureCamera(context, id, frames) else null
        val project = client.get(id)
        // Capture files can only be (re)written before the touch-up starts; afterwards `start` with the
        // same manifest is the companion's own idempotent answer.
        if (project.state == Project.State.New) {
            uploader.send(frames.map { UploadFile(UploadFile.Kind.Capture, it.name, file = it, type = "image/jpeg") }, id, resendCapture = true)
            if (cameraJson != null) client.addCaptureCamera(id, cameraJson)
        }
        sendPhotos(uploader, id, photos)
        return client.start(id, ReconstructionAnswers.captureManifest(frames.map { it.name }, cameraMetadataRequired = ar))
    }

    suspend fun sendPhotos(uploader: ProjectUploader, id: String, photos: List<File>, forMessage: Boolean = false): List<String> {
        if (photos.isEmpty()) return emptyList()
        val files = photos.map { UploadFile.image(it, name = "photo-${it.name}") }
        uploader.send(files, id, forMessage)
        photos.forEach { it.delete() }
        return files.map { it.name }
    }

    fun requireFiles(photos: List<File>) { if (photos.any { !it.exists() }) throw CompanionException("unreadable-file", "A photo couldn't be read.") }
}
