import Foundation
import AppKit
import UserNotifications
#if canImport(ControlKit)
import ControlKit
#endif

/// Delivery (PRD §8.8): the companion logs every user-visible change; this loop turns each one into a Mac
/// notification (per Settings), CloudKit records for the phone away from home, and Live Activity pushes through the
/// relay when one is configured. It also keeps the Mac awake while a pass or a print runs, and runs the phone's
/// commands that arrive through CloudKit (§9.3).
@MainActor final class EventRelay {
    static let shared = EventRelay()

    /// The long poll. local-control.md: `events.wait` holds its connection for `timeoutMs` plus 5 s.
    static let waitMs = 25_000

    private let socket = ModelAccessModel.socketPath(for: Installation(bundle: .main))
    private let defaults = UserDefaults.standard
    private var loop: Task<Void, Never>?
    private var upserts = UpsertGate()
    let cloud = CloudSync()
    let relay = LiveActivityRelay()
    private let notifier = MacNotifier()
    private let awake = AwakeKeeper()
    private var projects: [String: StmObject] = [:]
    private var projectsReadAt: Date?

    func start() {
        guard loop == nil else { return }
        notifier.prepare()
        cloud.start(runCommand: { [weak self] command, photos in await self?.run(command, photos: photos) ?? (false, "Counterpart isn't running.") })
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cloud.fetchCommands() }
        }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                let delay = await self?.cycle() ?? 30
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            }
        }
    }

    /// One read of the log. Returns how long to wait before the next (0 right away, after a long poll).
    private func cycle() async -> Double {
        guard let client = try? ControlClient(socketPath: socket, timeout: Double(Self.waitMs) / 1000 + 8) else { return 30 }
        guard let status = try? await client.status() else { return 10 }
        await refreshProjects(client, force: false)
        await cloud.tick(projects: projects)
        guard status.capabilities.events else { return 15 }
        var cursor = EventCursor(defaults: defaults)
        do {
            guard let current = cursor.value else {
                // First run: take the log's position first, then mirror every project as it is now. History isn't
                // replayed, and an event logged while the mirror uploads comes after the cursor, so the next read has it.
                let page = try await client.waitForEvents(after: 0, timeoutMs: 0, limit: 0)
                await refreshProjects(client, force: true)
                await cloud.mirror(Array(projects.values))
                cursor.value = page.latest
                return 0
            }
            let page = try await client.waitForEvents(after: current, timeoutMs: Self.waitMs)
            let (next, resync) = EventCursor.advance(from: current, page: page)
            if resync { await refreshProjects(client, force: true); await cloud.mirror(Array(projects.values)) }
            if !page.events.isEmpty { await refreshProjects(client, force: true) }
            await handle(page.events, client: client)
            cursor.value = next
            return 0
        } catch {
            return 5
        }
    }

    private func refreshProjects(_ client: ControlClient, force: Bool) async {
        if !force, let at = projectsReadAt, Date().timeIntervalSince(at) < 30 { return }
        guard let list = try? await client.objects() else { return }
        projects = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        projectsReadAt = Date()
        awake.set(busy: list.contains { $0.words.busy })
    }

    private func handle(_ events: [CounterpartEvent], client: ControlClient) async {
        let notified = NotifiedEvents(defaults: defaults)
        let prefs = NotificationPrefs(defaults: defaults)
        let now = Date()
        for (index, event) in events.enumerated() {
            let project = projects[event.projectId]
            let later = events[(index + 1)...].filter { $0.projectId == event.projectId }.map(\.type)
            if CatchUp.shouldNotify(event, now: now, prefs: prefs, alreadyNotified: notified.contains(event.id), later: later,
                                    state: project?.state.rawValue) {
                notifier.post(event, project: project)
                notified.insert(event.id)
            }
            let frame = event.frame.flatMap { project?.projectFile($0) }
            if event.notify != "none" { await cloud.save(event, frame: frame) }
            // A pause or resume keeps the stage at printing, so the printer's own state counts as a change too, and so
            // does the printer asking (or no longer asking) to confirm something.
            let state = [project?.words.stage.rawValue, project?.print?.live?.state ?? project?.print?.printerStatus?.state,
                         project?.printConfirmation?.id].map { $0 ?? "" }.joined(separator: "|")
            if let project, upserts.allow(projectId: project.id, printId: event.printId, state: state, now: now) {
                await cloud.mirror([project])
            }
            await relay.deliver(event, title: project?.words.title ?? event.title, client: client, cloudTokens: cloud.deviceTokens)
        }
    }

    /// Runs one command from the phone through the control method that already does the job. A deadline after
    /// sending has an unknown outcome, so it is reported, never run again.
    func run(_ command: PhoneCommand, photos: [String]) async -> (ok: Bool, message: String) {
        let capabilities = (try? await ControlClient(socketPath: socket).status())?.capabilities
        guard let call = command.call(photos: photos, acceptsText: capabilities?.structuredPasses ?? false,
                                      printSettings: capabilities?.printSettings ?? false) else {
            return (false, command.refusal)
        }
        do {
            let client = try ControlClient(socketPath: socket, timeout: ControlClient.timeout(for: call.method))
            // An answer with photos: the photos join the project first, so the pass that resumes uses them.
            if command.type == "answerAsk" {
                for photo in photos { _ = try await client.addFile(command.projectId, kind: "photos", path: photo) }
            }
            _ = try await client.run(call.method, call.params)
            return (true, "Done on your Mac.")
        } catch let error as ControlRemoteError {
            return (false, error.code == "conflict" && !error.message.isEmpty ? error.message : ObjectsModel.sentence(for: error))
        } catch ControlClientError.timedOut {
            return (false, "Your Mac didn't answer in time. Check the project before trying again.")
        } catch {
            return (false, ObjectsModel.sentence(for: error))
        }
    }
}

/// Mac notifications (PRD §9.1, Mac column), with the event's frame attached and one thread per project.
@MainActor final class MacNotifier: NSObject, UNUserNotificationCenterDelegate {
    func prepare() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ event: CounterpartEvent, project: StmObject?) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body
        content.threadIdentifier = event.projectId
        content.userInfo = ["projectId": event.projectId, "eventId": event.id]
        content.sound = event.notify == "passive" ? nil : .default
        content.interruptionLevel = event.notify == "timeSensitive" ? .timeSensitive : event.notify == "passive" ? .passive : .active
        if let frame = event.frame.flatMap({ project?.projectFile($0) }), FileManager.default.fileExists(atPath: frame.path) {
            // The system moves an attachment's file; give it a copy.
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("\(event.id).jpg")
            try? FileManager.default.removeItem(at: copy)
            if (try? FileManager.default.copyItem(at: frame, to: copy)) != nil,
               let attachment = try? UNNotificationAttachment(identifier: "frame", url: copy) { content.attachments = [attachment] }
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let projectId = response.notification.request.content.userInfo["projectId"] as? String
        await MainActor.run {
            if let projectId { AppModels.objects.selection = projectId }
            AppRouter.shared.open(.main)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}

/// Keeps the Mac from idle-sleeping while a pass or a print runs (PRD §7.6), and lets it sleep otherwise.
@MainActor final class AwakeKeeper {
    private var activity: NSObjectProtocol?
    func set(busy: Bool) {
        if busy, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled],
                                                             reason: "Counterpart is working on a project or a print")
        } else if !busy, let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
    }
}
