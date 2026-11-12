package com.scantomake.counterpart.api

/**
 * The conversation a project was made from (#600, #613): what was asked and answered for the project it was made from
 * (Make something else from this scan, or Duplicate), as the computer snapshotted it. Port of the inherited part of
 * CounterpartKit `ProjectConversation`; this project's own request stays where the page already shows it ("You asked").
 */
class ProjectConversation(project: Project, projects: List<Project> = emptyList()) {
    enum class Role { Person, Counterpart }
    data class Entry(val id: String, val role: Role, val text: String, val atMs: Double?, val showsTime: Boolean)

    /** The source project, with its title now when it still exists, else the title it had when this one was made. */
    val inheritedFrom: ScanLineage.Link? = project.inherited?.let { history ->
        val live = projects.firstOrNull { it.id == history.from.id }
        ScanLineage.Link(history.from.id, live?.let { ProjectWords.title(it) } ?: history.from.title, live != null)
    }
    val inheritedLine: String? get() = inheritedFrom?.let { "From “${it.title}”" + if (it.exists) "" else ", since deleted" }
    /** In time order; a time shows on the first and after an hour's gap, as on the iPhone. */
    val inheritedEntries: List<Entry> = run {
        var previous: Double? = null
        project.inherited?.items.orEmpty().mapIndexed { index, item ->
            val showsTime = previous?.let { item.at - it > 3_600_000 } ?: true
            previous = item.at
            Entry("inherited-$index", if (item.who == "you") Role.Person else Role.Counterpart, item.text, item.at, showsTime)
        }
    }
}
