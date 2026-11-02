import Foundation

/// The request and actual replies, shared by both clients. Logs and Ask controls stay in their own views.
public struct ProjectConversation: Equatable, Sendable {
    public struct Entry: Identifiable, Equatable, Sendable {
        public enum Role: Sendable { case person, counterpart }
        public var id: String
        public var role: Role
        public var text: String
        public var atMs: Double?
        /// Project-relative paths, ready for the existing image readers.
        public var photos: [String]
        public var status: String?
        public var showsTime = false
        public var firstParagraph: String {
            text.components(separatedBy: "\n\n").first ?? text
        }
        public var canExpand: Bool { firstParagraph != text }
    }
    public var entries: [Entry]
    public var otherPhotos: [String]

    public init(project: Project, queued: [CorrectionQueue.Message] = [], queueFailed: Bool = false) {
        var rows: [Entry] = []
        let initialPhotos = (project.requestPhotos ?? []).map { "photos/\($0)" } + (project.capture ?? []).map { "capture/\($0)" }
        if project.instructions?.isEmpty == false || !initialPhotos.isEmpty {
            rows.append(Entry(id: "request", role: .person, text: project.instructions ?? "", atMs: project.createdAtMs, photos: initialPhotos))
        }
        for message in project.messages ?? [] {
            let status = message.id == project.pendingMessageId ? "Message saved" :
                (message.id == project.completion?.messageId && project.completion?.undone != true ? "Marked Done" : nil)
            rows.append(Entry(id: "message-\(message.id)", role: .person, text: message.text, atMs: message.atMs,
                              photos: message.photos.map { "photos/\($0)" }, status: status))
        }
        for (index, pass) in project.passes.enumerated() {
            if pass.messageId == nil, let note = pass.note, !note.isEmpty {
                rows.append(Entry(id: "pass-\(index)-request", role: .person, text: note, atMs: pass.startedAtMs,
                                  photos: (pass.photos ?? []).map { "photos/\($0)" }))
            }
            if let reply = pass.summary, !reply.isEmpty {
                rows.append(Entry(id: "pass-\(index)-reply", role: .counterpart, text: reply,
                                  atMs: pass.endedAtMs ?? pass.startedAtMs, photos: []))
            }
        }
        if let completion = project.completion, completion.messageId == nil {
            rows.append(Entry(id: "completion", role: .person, text: completion.note, atMs: completion.atMs,
                              photos: [], status: completion.undone == true ? nil : "Marked Done"))
        }
        if let text = project.pendingFollowup, project.pendingMessageId == nil {
            rows.append(Entry(id: "pending", role: .person, text: text, atMs: nil, photos: [], status: "Message saved"))
        }
        for (index, message) in queued.enumerated() {
            // The first queued send may already be saved by the companion after an uncertain classification.
            if index == 0, message.text == project.pendingFollowup { continue }
            rows.append(Entry(id: "queued-\(message.id)", role: .person, text: message.text, atMs: message.atMs,
                              photos: (message.photos ?? []).map { "photos/\($0)" },
                              status: index == 0 && queueFailed ? "Check result before retrying" : "Waiting to send"))
        }
        // Preserve insertion order for equal timestamps, including request before reply.
        rows = rows.enumerated().sorted {
            let a = $0.element.atMs ?? .infinity, b = $1.element.atMs ?? .infinity
            return a == b ? $0.offset < $1.offset : a < b
        }.map(\.element)
        var previous: Double?
        for index in rows.indices {
            if let at = rows[index].atMs {
                rows[index].showsTime = previous.map { at - $0 > 3_600_000 } ?? true
                previous = at
            }
        }
        entries = rows
        let associated = Set(rows.flatMap(\.photos))
        otherPhotos = project.photos.map { "photos/\($0)" }.filter { !associated.contains($0) }
    }
}
