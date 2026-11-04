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
import com.scantomake.counterpart.api.UploadFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Photos chosen or taken for a project stay in the cache (ObjectsChosen) until the Mac has them. */
object Media {
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

    /**
     * Sends a finished scan's frames as a handheld capture (`POST …/capture?name=0001.jpg`) and its chosen photos,
     * then starts the project without a capture manifest: the Mac rebuilds the model from the frames
     * (mac-reconstruct, Apple's photogrammetry) and then touches it up, as it does for the iPhone's in-hand scan.
     */
    suspend fun sendProject(context: Context, uploader: ProjectUploader, client: CompanionClient, id: String, photos: List<File>): Project {
        val frames = if (captureFinished(context, id)) captureFrames(context, id) else emptyList()
        if (frames.isNotEmpty()) {
            uploader.send(frames.map { UploadFile(UploadFile.Kind.Capture, it.name, file = it, type = "image/jpeg") }, id)
        }
        sendPhotos(uploader, id, photos)
        val started = client.start(id)
        if (frames.isNotEmpty()) captureFolder(context, id).deleteRecursively()
        return started
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
