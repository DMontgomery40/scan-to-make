package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.Hex
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * What this phone keeps of its computer's projects, so a screen always draws what the phone has already shown, with or
 * without the computer (port of CounterpartKit `OnDeviceLibrary`; docs/design/overhaul/on-device-library.md). David,
 * Nov 11: "Never seen app in my life, since 2009 or so, struggle showing images it just had, 10 minutes later, because of
 * a dependency on some Mac mini".
 *
 * Android keeps it in `noBackupFilesDir` (app-private, never cleared by the system as `cacheDir` can be, and left out of
 * Auto Backup), one folder per paired computer, with an index (`index.json`) of each file's version, size, kind and when its
 * project was last opened.
 */
class OnDeviceLibrary(val base: File) {
    /** What the person chose to keep (Settings → Keep on this phone). */
    enum class Keep(val title: String, val ceiling: Long) {
        Pictures("Pictures only", 200L shl 20),
        Models("Pictures and 3D models", 500L shl 20),
        Everything("Everything, scans included", 2L shl 30);

        fun keeps(kind: Kind) = when (this) { Pictures -> kind == Kind.Picture; Models -> kind != Kind.Scan; Everything -> true }
        companion object { const val PREFS_KEY = "CounterpartLibraryKeep" }
    }

    /** Eviction lets kinds go in this order: scans, then models, then pictures. */
    enum class Kind {
        Scan, Model, Picture;
        companion object {
            fun of(name: String): Kind = when {
                name == "model.stl" || name.startsWith("original/") -> Model
                name.startsWith("scan/") || name.startsWith("capture/") || name.startsWith("photos/") -> Scan
                else -> Picture
            }
        }
    }

    @Serializable data class Entry(val project: String, val name: String, val version: Long, val file: String, val variant: String,
                                   val bytes: Long, val kind: Kind, val storedAtMs: Long)
    @Serializable data class Index(val entries: Map<String, Entry> = emptyMap(), val opened: Map<String, Long> = emptyMap(),
                                   val tooLarge: Set<String> = emptySet())

    private val lock = Any()
    private var mac: String? = null
    private var index = Index()
    @Volatile var keep: Keep = Keep.Models

    private fun folder(mac: String) = File(base, Hex.sha256(mac.toByteArray()).take(24))
    private fun key(project: String, name: String) = "$project#$name"
    val isActive: Boolean get() = synchronized(lock) { mac != null }

    /** Uses this computer's library; another computer's goes (a pairing to a different computer clears the old one's). */
    fun use(identity: String) = synchronized(lock) {
        if (mac == identity) return@synchronized
        mac = identity
        val keepFolder = folder(identity)
        base.listFiles()?.filter { it.canonicalPath != keepFolder.canonicalPath }?.forEach { it.deleteRecursively() }
        keepFolder.mkdirs()
        index = read(keepFolder)
    }

    /** Unpaired: everything kept goes. */
    fun unpair() = synchronized(lock) { mac = null; index = Index(); base.deleteRecursively() }

    /** Settings → Clear. */
    fun clear() = synchronized(lock) {
        val root = mac?.let(::folder) ?: return@synchronized
        root.deleteRecursively(); root.mkdirs(); index = Index()
    }

    fun file(project: String, name: String, version: Long, variant: String? = null): File? = synchronized(lock) {
        val root = mac?.let(::folder) ?: return@synchronized null
        val entry = index.entries[key(project, name)] ?: return@synchronized null
        if (entry.version != version || (variant != null && entry.variant != variant)) return@synchronized null
        File(File(root, project), entry.file).takeIf { it.exists() }
    }

    /** The newest copy kept, of any version: what a screen draws at once. */
    fun latest(project: String, name: String): Pair<File, Long>? = synchronized(lock) {
        val root = mac?.let(::folder) ?: return@synchronized null
        val entry = index.entries[key(project, name)] ?: return@synchronized null
        File(File(root, project), entry.file).takeIf { it.exists() }?.let { it to entry.version }
    }

    val entries: List<Entry> get() = synchronized(lock) { index.entries.values.toList() }
    val usage: Long get() = synchronized(lock) { index.entries.values.sumOf { it.bytes } }
    fun lastOpened(project: String): Long? = synchronized(lock) { index.opened[project] }
    fun isTooLarge(project: String, name: String, version: Long) = synchronized(lock) { "${key(project, name)}#$version" in index.tooLarge }

    /** Writes a fully arrived file into place; that one file's older version goes only now. */
    fun commit(bytes: ByteArray, project: String, name: String, version: Long, variant: String): File = synchronized(lock) {
        val root = mac?.let(::folder) ?: throw IllegalStateException("no computer")
        val k = key(project, name)
        index.entries[k]?.let { current ->
            if (current.version > version || (current.version == version && current.variant == variant)) return@synchronized File(File(root, project), current.file)
        }
        val projectFolder = File(root, project).apply { mkdirs() }
        val target = File(projectFolder, "v$version-$variant")
        val temp = File(projectFolder, "${target.name}.part")
        temp.writeBytes(bytes)
        if (!temp.renameTo(target)) { temp.delete(); throw IllegalStateException("rename") }
        index.entries[k]?.takeIf { it.file != target.name }?.let { File(projectFolder, it.file).delete() }
        index = index.copy(entries = index.entries + (k to Entry(project, name, version, target.name, variant, target.length(), Kind.of(name), System.currentTimeMillis())))
        save(root)
        target
    }

    fun markTooLarge(project: String, name: String, version: Long) = synchronized(lock) {
        index = index.copy(tooLarge = index.tooLarge + "${key(project, name)}#$version")
        mac?.let { save(folder(it)) }
    }

    fun opened(project: String, atMs: Long = System.currentTimeMillis()) = synchronized(lock) {
        index = index.copy(opened = index.opened + (project to atMs))
        mac?.let { save(folder(it)) }
    }

    /** A project the list no longer has: its files go. */
    fun prune(keeping: Set<String>) = synchronized(lock) {
        val root = mac?.let(::folder) ?: return@synchronized
        val gone = (index.entries.values.map { it.project } + index.opened.keys).toSet() - keeping
        if (gone.isEmpty()) return@synchronized
        gone.forEach { File(root, it).deleteRecursively() }
        index = Index(index.entries.filterValues { it.project !in gone }, index.opened - gone,
                      index.tooLarge.filterTo(mutableSetOf()) { t -> gone.none { t.startsWith("$it#") } })
        save(root)
    }

    /** Under the ceiling and to what the person keeps: kinds no longer kept, then scans, models, pictures, each from the
     *  project opened longest ago. Returns what went, in order. */
    fun evict(keep: Keep = this.keep, ceiling: Long = keep.ceiling): List<Entry> = synchronized(lock) {
        val root = mac?.let(::folder) ?: return@synchronized emptyList()
        val order = compareBy<Entry>({ it.kind.ordinal }, { index.opened[it.project] ?: Long.MIN_VALUE }, { -it.bytes })
        var total = index.entries.values.sumOf { it.bytes }
        val removed = mutableListOf<Entry>()
        val entries = index.entries.toMutableMap()
        fun remove(e: Entry) { File(File(root, e.project), e.file).delete(); entries.remove(key(e.project, e.name)); total -= e.bytes; removed += e }
        index.entries.values.sortedWith(order).filter { !keep.keeps(it.kind) }.forEach(::remove)
        for (e in entries.values.sortedWith(order)) { if (total <= ceiling) break; remove(e) }
        if (removed.isNotEmpty()) { index = index.copy(entries = entries); save(root) }
        removed
    }

    private val json = Json { ignoreUnknownKeys = true }
    private fun read(root: File): Index = runCatching { json.decodeFromString<Index>(File(root, "index.json").readText()) }.getOrNull()
        ?.let { i -> i.copy(entries = i.entries.filterValues { File(File(root, it.project), it.file).exists() }) } ?: Index()
    private fun save(root: File) {
        val temp = File(root, "index.json.part")
        runCatching { temp.writeText(json.encodeToString(index)); temp.renameTo(File(root, "index.json")) }
    }
}

/** What the background fill wants, and what it fetches by itself on the link it has (CounterpartKit `LibraryPlan`). */
object LibraryPlan {
    data class Want(val project: Project, val name: String, val kind: OnDeviceLibrary.Kind, val bytes: Double?)

    /** The largest file fetched by itself on a metered link (cellular, a hotspot, Data Saver). */
    const val METERED_LIMIT = 25.0 * 1024 * 1024
    const val RECENT_MODELS = 3

    fun fetches(want: Want, keep: OnDeviceLibrary.Keep, metered: Boolean): Boolean {
        if (!keep.keeps(want.kind)) return false
        if (want.kind == OnDeviceLibrary.Kind.Picture || !metered) return true
        return (want.bytes ?: return false) <= METERED_LIMIT
    }

    fun wants(projects: List<Project>, opened: Set<String>, keep: OnDeviceLibrary.Keep): List<Want> {
        val pictures = mutableListOf<Want>(); val models = mutableListOf<Want>(); val scans = mutableListOf<Want>()
        val recent = projects.sortedByDescending { it.mediaVersion }.take(RECENT_MODELS).map { it.id }.toSet()
        for (p in projects) {
            val names = linkedSetOf<String>()
            p.picturePath()?.let(names::add)
            p.pictures.toSortedMap().values.forEach { names.add(it) }
            if (p.id in opened) {
                p.plates.orEmpty().mapNotNull { it.thumbnail }.forEach { names.add(it) }
                p.openAsk?.takeIf { it.photo != null }?.let { names.add("asks/${it.id}.jpg") }
            }
            names.filter { it.isNotEmpty() }.forEach { pictures += Want(p, it, OnDeviceLibrary.Kind.Picture, null) }
            if (p.current != null && (p.id in opened || p.id in recent)) models += Want(p, "model.stl", OnDeviceLibrary.Kind.Model, null)
            if (p.id in opened) ProjectGallery.scanModels(p).firstOrNull()?.let { path ->
                // Android's model has no scan file sizes yet: a scan waits for an unmetered link.
                scans += Want(p, path, OnDeviceLibrary.Kind.Scan, null)
            }
        }
        return (pictures + models + scans).filter { keep.keeps(it.kind) }
    }
}
