import Foundation
import AppKit
import ServiceManagement
#if canImport(ControlKit)
import ControlKit
#endif

/// PRD §5.9: settings live in the companion, and both apps read and write the same values (docs/protocols/settings.md).
/// This Mac applies the ones that change it (open at login, the Dock, keeping awake) whenever they change, on either
/// device: at launch, on `settings.changed`, and on a 30 s read in case an event was missed. An older companion that
/// doesn't keep them leaves this Mac's own settings as they are.
@MainActor final class CompanionSettingsModel: ObservableObject {
    static let shared = CompanionSettingsModel()

    @Published private(set) var settings: CompanionSettings?
    /// One write at a time, so a slower earlier write never lands after a newer one.
    @Published private(set) var saving = false
    @Published var problem: String?
    private var readAt: Date?
    private var lastAIOutcome: String?
    private lazy var phoneFusion = PhoneFusionSetup(
        report: { [weak self] in
            guard let self else { return }
            let installed = FusionSetup.installedFusion() != nil
            let running = NSWorkspace.shared.runningApplications.contains { ["com.autodesk.fusion360", "com.autodesk.mas.fusion360"].contains($0.bundleIdentifier ?? "") }
            try await ControlClient(socketPath: self.socket).reportFusion(installed: installed,
                configured: FusionSetup.isSetUp(state: Installation(bundle: .main).state), running: running)
        },
        claim: { [weak self] claimant in guard let self else { return nil }; return try await ControlClient(socketPath: self.socket).claimFusionSetup(claimantId: claimant) },
        install: {
            do {
                let result = try await FusionSetup.install(state: Installation(bundle: .main).state)
                return (result.status.ok, result.status.phoneMessage)
            } catch { return (false, "Fusion setup did not finish. Check Counterpart on your Mac, then try again.") }
        },
        complete: { [weak self] id, ok, message in
            guard let self else { return }
            try await ControlClient(socketPath: self.socket).fusionSetupDone(requestId: id, ok: ok, message: message)
        })

    /// The companion keeps General (`general.*`).
    var keepsGeneral: Bool { settings?.general != nil }
    /// The companion keeps the Mac's notification switches (`notifications.mac`).
    var keepsNotifications: Bool { settings?.notificationsMac != nil }

    private var socket: String { ModelAccessModel.socketPath(for: Installation(bundle: .main)) }

    /// Reads the settings (at most every 30 s unless forced) and applies them to this Mac.
    func refresh(force: Bool = false) async {
        #if DEBUG
        // Design QA: `--design-companion-settings` shows Settings as a companion that keeps them, without touching this Mac.
        if DesignFixtures.assets != nil {
            if CommandLine.arguments.contains("--design-companion-settings") {
                settings = CompanionSettings(milestones: "50", notificationsMac: Dictionary(uniqueKeysWithValues: MacNotificationTypes.ordered.map {
                    ($0.type, ["pass.ready", "pass.ask", "pass.failed", "print.confirm", "print.paused", "print.done", "print.failed",
                               "print.not-started", "mcp.update.failed"].contains($0.type)) }),
                    general: .init(openAtLogin: true, showInDock: true, keepAwake: true))
            }
            return
        }
        #endif
        if !force, let readAt, Date().timeIntervalSince(readAt) < 30 { return }
        await phoneFusion.refresh()
        guard let read = try? await ControlClient(socketPath: socket).companionSettings() else { return }
        readAt = Date()
        // The first time the companion keeps them, this Mac's own choices go up rather than its defaults coming down.
        if !UserDefaults.standard.bool(forKey: Self.migratedKey), read.general != nil || read.notificationsMac != nil {
            let patch = SettingsMigration.patch(defaults: .standard, companion: read, currentGeneral: SettingsMigration.currentGeneral(
                loginStatus: SMAppService.mainApp.status, showInDock: DockIcon.shown,
                keepAwake: EventRelay.shared.awake.allowed))
            if patch.isEmpty {
                UserDefaults.standard.set(true, forKey: Self.migratedKey)
            } else if let after = try? await ControlClient(socketPath: socket).setSettings(patch) {
                UserDefaults.standard.set(true, forKey: Self.migratedKey)
                apply(after)
                return
            } else {
                return // carried over on the next read; nothing of this Mac's is overwritten meanwhile
            }
        }
        apply(read)
    }

    static let migratedKey = "settings.movedToCompanion"


    /// Writes some keys; the companion answers with every setting, which this Mac then applies.
    @discardableResult func set(_ patch: [String: JSONValue]) async -> Bool {
        guard !saving else { return false }
        saving = true
        defer { saving = false }
        problem = nil
        do {
            apply(try await ControlClient(socketPath: socket).setSettings(patch))
            return true
        } catch let error as ControlRemoteError where !error.message.isEmpty {
            problem = error.message
        } catch {
            problem = "Counterpart couldn't save that. Try again."
        }
        await refresh(force: true)
        return false
    }

    func setGeneral(_ key: String, _ on: Bool) async { await set(["general": .object([key: .bool(on)])]) }
    func setNotification(_ type: String, _ on: Bool) async { await set(["notifications": .object(["mac": .object([type: .bool(on)])])]) }

    /// `settings.changed` (docs/protocols/settings.md): read the new values, and run what only this Mac can.
    func changed(_ event: CounterpartEvent) async {
        await refresh(force: true)

    }

    /// Makes this Mac match the settings.
    func apply(_ new: CompanionSettings) {
        settings = new
        // Follow the companion's switches while it keeps them; an older companion's answer clears them, so the switches
        // Settings shows (this Mac's own) are the ones that count.
        NotificationPrefs().types = new.notificationsMac
        if let level = new.milestones.flatMap(ProgressNotifications.init(milestones:)), NotificationPrefs().progress != .off {
            NotificationPrefs().progress = level
        }
        if let general = new.general {
            if let showInDock = general.showInDock, showInDock != DockIcon.shown {
                UserDefaults.standard.set(showInDock, forKey: DockIcon.key)
                DockIcon.apply()
            }
            if let keepAwake = general.keepAwake { EventRelay.shared.awake.allowed = keepAwake }
            if let openAtLogin = general.openAtLogin { applyLogin(openAtLogin) }
        }
        // A Test from the phone that needs the sign-in to finish here: show it on this Mac, once.
        if new.aiCheckOutcome != lastAIOutcome {
            lastAIOutcome = new.aiCheckOutcome
            if new.aiCheckOutcome == "needs-gui-session" { SettingsTab.open(.ai) }
        }
    }

    /// Open at login, for the installed app only (a test or design variant never registers itself).
    private func applyLogin(_ on: Bool) {
        UserDefaults.standard.set(!on, forKey: "openAtLoginOff")
        guard Installation(bundle: .main).variant.isEmpty else { return }
        do {
            switch LoginRegistrationAction.resolve(on: on, status: SMAppService.mainApp.status) {
            case .none: break
            case .register: try SMAppService.mainApp.register()
            case .unregister: try SMAppService.mainApp.unregister()
            case .approvalRequired: problem = "Allow Counterpart in System Settings → General → Login Items."
            case .unavailable: problem = "Counterpart couldn't check its login setting. Try again from Settings on this Mac."
            }
        } catch {
            problem = "Allow Counterpart in System Settings → General → Login Items."
        }
    }

}
