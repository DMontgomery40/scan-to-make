package com.scantomake.counterpart.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.ui.posterName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The same real-object-first picture as Home, sized for an ongoing print notification. */
object NotificationPictures {
    private val pictures = LruCache<String, Bitmap>(8)
    fun key(project: Project) = "${project.id}/${project.mediaVersion}/${project.posterName()}"
    fun cached(project: Project): Bitmap? = pictures.get(key(project))

    suspend fun refresh(project: Project): Bitmap? = withContext(Dispatchers.IO) {
        cached(project) ?: try {
            val name = project.posterName() ?: return@withContext null
            val file = Counterpart.instance.companion.download(project, name)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 256) sample *= 2
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
                ?.also { pictures.put(key(project), it) }
        } catch (_: Exception) { null }
    }
}
