import Foundation
import AppKit
import UserNotifications
import CounterpartKit
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
    let awake = AwakeKeeper()
    private var projects: [String: Project] = [:]
    private var projectsReadAt: Date?

    func start() {
        guard loop == nil else { return }
        notifier.prepare()
        relay.undelivered = { [weak self] event in await self?.saveUndeliveredMilestone(event) ?? false }
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
        await relay.recover(client: client, cloudTokens: cloud.deviceTokens)
        await CompanionSettingsModel.shared.refresh()
        await cloud.publishMacIfDue(client)
        guard status.capabilities.events else { return 15 }
        var cursor = EventCursor(defaults: defaults)
        do {
            guard let current = cursor.value else {
                // First run: take the log's position first, then mirror every project as it is now. History isn't
                // replayed, and an event logged while the mirror uploads comes after the cursor, so the next read has it.
                let page = try await client.waitForEvents(after: 0, timeoutMs: 0, limit: 0)
                guard await refreshProjects(client, force: true) else { return 5 }
                await cloud.mirror(Array(projects.values))
                cursor.value = page.latest
                return 0
            }
            let page = try await client.waitForEvents(after: current, timeoutMs: Self.waitMs)
            let (next, resync) = EventCursor.advance(from: current, page: page)
            // The page is acknowledged only once the projects it is about were read: a terminal event is never
            // mirrored or pushed against an old snapshot. The same page is read again after a failed read.
            if resync || !page.events.isEmpty {
                guard await refreshProjects(client, force: true) else { return 5 }
            }
            if resync { await cloud.mirror(Array(projects.values)) }
            await handle(page.events, client: client)
            cursor.value = next
            return 0
        } catch {
            return 5
        }
    }

    /// Reads the projects (at most every 30 s unless forced). Returns whether this snapshot is current.
    @discardableResult private func refreshProjects(_ client: ControlClient, force: Bool) async -> Bool {
        if !force, let at = projectsReadAt, Date().timeIntervalSince(at) < 30 { return true }
        // The window shows this read too, in order with its own: a `pass.*` event changes the badge at once.
        let read = AppModels.objects.startRead()
        guard let (list, extras) = try? await client.objectsAndExtras() else { return false }
        AppModels.objects.apply(read: read, list, extras)
        projects = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        // The ~/Downloads watch follows the projects' Asks while no window is open, too (PRD §8.11).
        DownloadsWatcher.shared.follow(extras, titles: Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0.words.title) }))
        projectsReadAt = Date()
        awake.set(busy: list.contains { $0.words.busy })
        return true
    }

    private func handle(_ events: [CounterpartEvent], client: ControlClient) async {
        let notified = NotifiedEvents(defaults: defaults)
        let prefs = NotificationPrefs(defaults: defaults)
        let now = Date()
        for (index, event) in events.enumerated() {
            // A setting changed on either device (PRD §5.9): read it and apply it here.
            if event.type == "settings.changed" { await CompanionSettingsModel.shared.changed(event) }
            // An MCP update (PRD §8.10): Settings shows it; when it finished, the printers are read again for the version.
            if PrinterUpdates.shared.apply(event) { await AppModels.objects.refresh() }
            let project = event.projectId.flatMap { projects[$0] }
            let later = events[(index + 1)...].filter { $0.projectId == event.projectId }.map(\.type)
            if CatchUp.shouldNotify(event, now: now, prefs: prefs, alreadyNotified: notified.contains(event.id), later: later,
                                    state: project?.state.rawValue) {
                notifier.post(event, project: project)
                notified.insert(event.id)
            }
            let frame = event.frame.flatMap { project?.projectFile($0) }
            // A milestone while the print's Live Activity runs alerts on the activity instead (David, Nov 8): no CloudKit
            // event, so no separate notification. Without a running activity it is a notification as before.
            let onActivity = await relay.alertMilestone(event, title: project?.words.title ?? event.title, client: client,
                                                        cloudTokens: cloud.deviceTokens)
            if event.notify != "none", !onActivity { await cloud.save(event, frame: frame) }
            // A pause or resume keeps the stage at printing, so the printer's own state counts as a change too, and so
            // does the printer asking (or no longer asking) to confirm something.
            let state = [project?.words.stage.rawValue, project?.print?.live?.state ?? project?.print?.printerStatus?.state,
                         project?.printConfirmation?.id].map { $0 ?? "" }.joined(separator: "|")
            if let project, upserts.allow(projectId: project.id, printId: event.printId, state: state, now: now) {
                await cloud.mirror([project])
            }
            // A start replayed after a restart, for a print that has since ended, would start an activity nothing ends.
            if event.type == "print.started", !LiveActivityStart.stillRunning(event, project: project) { continue }
            await relay.deliver(event, title: project?.words.title ?? event.title, client: client, cloudTokens: cloud.deviceTokens)
        }
    }

    private func saveUndeliveredMilestone(_ event: CounterpartEvent) async -> Bool {
        let project = event.projectId.flatMap { projects[$0] }
        return await cloud.save(event, frame: event.frame.flatMap { project?.projectFile($0) })
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
            guard let prepared = try await command.preparedCall(photos: photos, acceptsText: capabilities?.structuredPasses ?? false,
                                                               printSettings: capabilities?.printSettings ?? false,
                                                               addPhoto: { try await client.addPhotoFile(command.projectId, path: $0, forMessage: true) }) else {
                return (false, command.refusal)
            }
            _ = try await client.run(prepared.method, prepared.params)
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

    func post(_ event: CounterpartEvent, project: Project?) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body
        content.threadIdentifier = event.projectId ?? event.type
        content.userInfo = ["eventId": event.id].merging(event.projectId.map { ["projectId": $0] } ?? [:]) { $1 }
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
    private var busy = false
    /// Settings → General → Keep the Mac awake while working (`general.keepAwake`).
    var allowed = true { didSet { set(busy: busy) } }
    func set(busy: Bool) {
        self.busy = busy
        let busy = busy && allowed
        if busy, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled],
                                                             reason: "Counterpart is working on a project or a print")
        } else if !busy, let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
    }
}
