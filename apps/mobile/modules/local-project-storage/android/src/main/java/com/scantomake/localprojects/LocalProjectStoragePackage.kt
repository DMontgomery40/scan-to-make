package com.scantomake.localprojects

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import android.database.sqlite.SQLiteDatabase

class LocalProjectStoragePackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(LocalProjectStorageModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class LocalProjectStorageModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "LocalProjectStorage"
  private fun <T> run(promise: Promise, body: (SQLiteDatabase) -> T) {
    try {
      val path = context.getDatabasePath("saved-projects.sqlite3")
      path.parentFile?.mkdirs()
      SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
        db.execSQL("PRAGMA synchronous=FULL")
        db.execSQL("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, bytes BLOB NOT NULL)")
        promise.resolve(body(db))
      }
    } catch (error: Exception) { promise.reject("local_storage", "Local project storage could not complete the operation.", error) }
  }
  @ReactMethod fun listIds(promise: Promise) = run(promise) { db ->
    val result = Arguments.createArray()
    db.rawQuery("SELECT id FROM projects ORDER BY id", null).use { cursor -> while (cursor.moveToNext()) result.pushString(cursor.getString(0)) }
    result
  }
  @ReactMethod fun read(id: String, promise: Promise) = run(promise) { db ->
    db.rawQuery("SELECT bytes FROM projects WHERE id=?", arrayOf(id)).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0).toString(Charsets.UTF_8) else null }
  }
  @ReactMethod fun compareAndSwap(id: String, expected: String?, next: String, promise: Promise) = run(promise) { db ->
    db.beginTransaction()
    try {
      val sql = if (expected == null) "INSERT OR IGNORE INTO projects(id,bytes) VALUES (?,?)" else "UPDATE projects SET bytes=? WHERE id=? AND bytes=?"
      val changed = db.compileStatement(sql).use { statement ->
        statement.bindString(if (expected == null) 1 else 2, id)
        statement.bindBlob(if (expected == null) 2 else 1, next.toByteArray(Charsets.UTF_8))
        if (expected != null) statement.bindBlob(3, expected.toByteArray(Charsets.UTF_8))
        statement.executeUpdateDelete() == 1
      }
      db.setTransactionSuccessful()
      changed
    } finally { db.endTransaction() }
  }
}
