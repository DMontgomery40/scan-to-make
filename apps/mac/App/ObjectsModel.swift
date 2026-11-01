import Foundation
import Combine
#if canImport(ControlKit)
import ControlKit
#endif

/// What the objects window needs from the companion: local-control's `objects.*` methods.
protocol ObjectsCompanion: Sendable {
    func printers() async throws -> PrinterCatalog
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity]
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject
    func objects() async throws -> [StmObject]
    func correct(_ id: String, note: String) async throws -> StmObject
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> StmObject
    func print(_ id: String, checked: Bool) async throws -> StmObject
    func answerPlate(_ id: String) async throws -> StmObject
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> StmObject
    func start(_ id: String) async throws -> StmObject
    func delete(_ id: String) async throws
}

extension ObjectsCompanion {
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> StmObject { throw ControlClientError.unavailable }
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] { throw ControlClientError.unavailable }
    func printers() async throws -> PrinterCatalog { throw ControlClientError.unavailable }
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject { throw ControlClientError.unavailable }
}

/// The control socket. A fresh client per call, so a missing socket fails that call, not the model.
struct SocketObjects: ObjectsCompanion {
    let path: String
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] { try await ControlClient(socketPath:path).passActivity(id, index:index) }
    func printers() async throws -> PrinterCatalog { try await ControlClient(socketPath:path).printers() }
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject { try await ControlClient(socketPath:path).selectPrinter(id, destinationId:destinationId) }
    func objects() async throws -> [StmObject] { try await ControlClient(socketPath:path).objects() }
    func correct(_ id: String, note: String) async throws -> StmObject { try await ControlClient(socketPath:path).correctObject(id, note:note) }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> StmObject { try await ControlClient(socketPath:path).answerCloseup(id, bestGuess:bestGuess) }
    func print(_ id: String, checked: Bool) async throws -> StmObject { try await ControlClient(socketPath:path).printObject(id, checked:checked) }
    func answerPlate(_ id: String) async throws -> StmObject { try await ControlClient(socketPath:path).answerPlate(id) }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> StmObject {
        try await ControlClient(socketPath:path).answerPrintConfirmation(id, confirmationId:confirmationId, answer:answer)
    }
    func start(_ id: String) async throws -> StmObject { try await ControlClient(socketPath:path).startObject(id) }
    func delete(_ id: String) async throws { try await ControlClient(socketPath:path).deleteObject(id) }
}

/// The objects window's list and the object it shows (spec §5.1, §5.6). It reads the list only while the
/// window is on screen: every 3 s while something is busy, and every 15 s otherwise so a new scan from
/// the phone still shows up. Opening or focusing the window reads it at once.
@MainActor final class ObjectsModel: ObservableObject {
    enum Availability: Equatable {
        case loading, ready
        /// The companion refused the list: objects aren't set up on this Mac (or it predates them).
        case notSetUp
        /// The companion hasn't answered for a while.
        case notRunning
    }
    /// One sentence about an action that didn't go through, shown on that object's page.
    struct Problem: Equatable { let id: String, text: String }

    static let busyDelay: Double = 3, idleDelay: Double = 15

    @Published private(set) var objects: [StmObject] = []
    @Published private(set) var printerCatalog: PrinterCatalog?
    @Published private(set) var availability = Availability.loading
    @Published var selection: String?
    @Published private(set) var working: Set<String> = []
    @Published private(set) var problem: Problem?
    private let companion: any ObjectsCompanion
    private var loop: Task<Void, Never>?
    private var failures = 0

    init(companion: any ObjectsCompanion) { self.companion = companion }

    var selected: StmObject? { objects.first { $0.id == selection } }
    var isPolling: Bool { loop != nil }

    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] {
        try await companion.passActivity(id, index:index)
    }

    func printer(for object: StmObject) -> PrinterDestination? {
        guard let catalog = printerCatalog else { return nil }
        return catalog.destinations.first { $0.id == (object.printerDestinationId ?? catalog.defaultDestinationId) }
    }
    func selectPrinter(_ id: String, destinationId: String) async {
        guard !working.contains(id) else { return }
        working.insert(id)
        defer { working.remove(id) }
        do {
            let updated = try await companion.selectPrinter(id, destinationId:destinationId)
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
            problem = nil
        } catch { problem = Problem(id:id, text:Self.sentence(for:error)) }
    }

    /// Reads the list once and returns the seconds until the next read.
    @discardableResult func refresh() async -> Double {
        do {
            let list = try await companion.objects()
            failures = 0
            objects = list
            printerCatalog = try? await companion.printers()
            availability = .ready
            if !list.contains(where: { $0.id == selection }) { selection = list.first?.id }
            if let problem, !list.contains(where: { $0.id == problem.id }) { self.problem = nil }
            return list.contains { $0.words.busy } ? Self.busyDelay : Self.idleDelay
        } catch is ControlRemoteError {
            // The companion answered and refused: `unavailable` when objects aren't set up here, or
            // `invalid-request` from a companion that predates objects. Either way it is running.
            failures = 0
            objects = []
            availability = .notSetUp
            return Self.idleDelay
        } catch {
            // The companion may be starting or restarting: keep what's shown for a few tries.
            failures += 1
            if failures >= 3 { availability = .notRunning }
            return Self.busyDelay
        }
    }

    /// The window is on screen (true) or closed, hidden or covered (false).
    func setVisible(_ visible: Bool) {
        if !visible { loop?.cancel(); loop = nil; return }
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.refresh() else { return }
                try? await Task.sleep(for:.seconds(delay))
            }
        }
    }

    /// Read now and restart the cadence, e.g. when the window becomes key or after an action.
    func wake() {
        guard loop != nil else { return }
        setVisible(false); setVisible(true)
    }

    /// Runs one action on one object. Returns whether it went through.
    @discardableResult func perform(_ action: ObjectAction, on id: String, note: String = "") async -> Bool {
        guard !working.contains(id) else { return false }
        if action == .plateClear, objects.first(where:{ $0.id == id })?.printConfirmation != nil {
            problem = Problem(id:id, text:"Review the printer's confirmation before continuing.")
            return false
        }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated: StmObject
            switch action {
            case .print: updated = try await companion.print(id, checked:false)
            case .printChecked: updated = try await companion.print(id, checked:true)
            case .correct: updated = try await companion.correct(id, note:String(note.trimmingCharacters(in:.whitespacesAndNewlines).prefix(4000)))
            case .bestGuess: updated = try await companion.answerCloseup(id, bestGuess:true)
            case .plateClear: updated = try await companion.answerPlate(id)
            case .retry: updated = try await companion.start(id)
            }
            if let index = objects.firstIndex(where: { $0.id == id }) { objects[index] = updated }
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            // A refusal usually means the object moved on (another device, or a finished step): show where it is now.
            await refresh()
            return false
        }
    }

    @discardableResult func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async -> Bool {
        guard !working.contains(id) else { return false }
        guard let question = objects.first(where:{ $0.id == id })?.printConfirmation, question.id == confirmationId else {
            problem = Problem(id:id, text:"That print confirmation has changed. Review the current request.")
            return false
        }
        if answer.action == .accept, !question.canAccept(answer.content ?? [:], at:Date().timeIntervalSince1970 * 1000) {
            problem = Problem(id:id, text:"Complete the required checks before confirming this print. The request may have expired.")
            return false
        }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated = try await companion.answerPrintConfirmation(id, confirmationId:confirmationId, answer:answer)
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            await refresh()
            return false
        }
    }

    /// Deletes one object from this Mac. The page moves to the next object (or the one before the last).
    /// Returns whether it went through; if not, the object stays and its page says why.
    @discardableResult func delete(_ id: String) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            try await companion.delete(id)
            if let index = objects.firstIndex(where: { $0.id == id }) {
                objects.remove(at:index)
                if selection == id { selection = objects.isEmpty ? nil : objects[min(index, objects.count - 1)].id }
            }
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            return false
        }
    }

    /// One plain sentence for an action that didn't go through.
    nonisolated static func sentence(for error: Error) -> String {
        switch (error as? ControlRemoteError)?.code {
        case "conflict"?:
            // A current Mac sends its own plain sentence ("There is no model to print yet.").
            let message = (error as? ControlRemoteError)?.message ?? ""
            return message.isEmpty || message.hasPrefix("The requested operation") ? "That can't be done right now." : message
        case "not-found"?: return "This one is no longer on your Mac."
        case .some: return "Something went wrong on your Mac."
        case nil: break
        }
        switch error as? ControlClientError {
        case .timedOut?: return "That's taking longer than usual. This page will update when it's done."
        case .unavailable?: return "Counterpart couldn’t start in the background."
        default: return "Something went wrong on your Mac."
        }
    }
}
