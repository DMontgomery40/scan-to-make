import Foundation
import struct CounterpartKit.Project
#if canImport(ControlKit)
import ControlKit
#endif

/// #828: when an app update may replace Counterpart.app. Checking for an update is always allowed; installing one stops
/// the companion agent, which runs from inside the app (62dccb41, Oct 31: "Until MAC-4 exposes busy/idle state, require
/// the service to be stopped"). So the install waits while stopping it would cut work short.
enum UpdateGate {
    enum Decision: Equatable {
        case install
        /// Work is in progress; ask again later.
        case wait
    }

    /// The plain sentence shown while an install waits.
    static let waitingSentence = "Counterpart will update as soon as the print or cleanup it’s working on is finished."

    /// Work that stopping the companion would cut short:
    /// - a pass (touching up, making changes) is running;
    /// - a print is being prepared, sliced or sent and the printer doesn't have it yet;
    /// - the printer is asking for a yes (the companion holds that question);
    /// - a phone is sending a new project's files.
    /// A print the printer already has keeps printing without the companion, whose monitor resumes after a restart
    /// (services/companion/src/printing/monitor.ts), so it doesn't hold an update for hours.
    static func interrupts(_ project: Project) -> Bool {
        if project.state == .new { return !ObjectWords.isDraft(project) }
        let words = ObjectWords(project)
        return words.busy && !words.printRunning
    }

    /// Whether quitting would install a downloaded update: Sparkle's installer, once started, waits for the app to quit
    /// (Install and Relaunch, or a dismissed Ready to Install; SPUUpdaterDelegate.h). Fed from Sparkle's callbacks.
    struct Staging {
        enum Event {
            /// `didExtractUpdate`.
            case extracted
            /// `willInstallUpdate` or the relaunch postponed.
            case installing
            /// `userDidMake(_:forUpdate:state:)`: Skip, and whether the installer had started (`state.stage == .installing`).
            case choice(skip: Bool, installerStarted: Bool)
            /// `didAbortWithError` (review F6); "no update found" says nothing about one already waiting.
            case aborted(noUpdateFound: Bool)
        }
        private(set) var staged = false
        mutating func apply(_ event: Event) {
            switch event {
            case .extracted, .installing: staged = true
            case .choice(let skip, let started): if skip { staged = false } else if started { staged = true }
            case .aborted(let noUpdateFound): if !noUpdateFound { staged = false }
            }
        }
    }

    /// One ask, on its own (`Waiter` keeps the clock across asks).
    static func decide(_ projects: Result<[Project], Error>) -> Decision {
        var waiter = Waiter()
        return waiter.next(projects)
    }

    /// Asks in a row, with a clock (review F5). A companion that isn't there (no socket, refused) has nothing running to
    /// protect. One that answers `busy`, an error, something unreadable, or not in time may be working, so it holds the
    /// install, but for `limit` seconds of wall-clock time at most, so an update is never refused for good.
    struct Waiter {
        static let limit: TimeInterval = 600
        private var unansweredSince: Date?

        mutating func next(_ projects: Result<[Project], Error>, now: Date = Date()) -> Decision {
            switch projects {
            case .success(let projects):
                unansweredSince = nil
                return projects.contains(where: interrupts) ? .wait : .install
            case .failure(let error):
                // #850: a companion that says it has no projects (`unavailable`, beta 6 with no printer) has none to protect.
                let noProjects = (error as? ControlRemoteError)?.code == "unavailable"
                let answeredBadly = (error is ControlRemoteError && !noProjects)
                    || [.timedOut, .invalidResponse].contains(error as? ControlClientError)
                guard answeredBadly else { unansweredSince = nil; return .install }
                let since = unansweredSince ?? now
                unansweredSince = since
                return now.timeIntervalSince(since) >= Self.limit ? .install : .wait
            }
        }
    }
}

/// #828: quitting with a downloaded update waiting, which Sparkle installs as soon as the app has quit. Its effects are
/// injected (`Updates` gives the real ones), so the decisions are tested.
/// - Idle: the agent is unregistered (stopped), and the next launch registers it again (`stopped`).
/// - Working, or no answer within the ask's 4 s (review F1): the quit is refused with the waiting sentence, and the app
///   quits by itself once the work is done. That quit isn't asked about again, so it never loops (review R1). The
///   window's Don't Quit calls it off (review R2); a busy answer is never capped here, as a pass may run 40 minutes.
/// - launchd refusing the unregister (review R1): quit anyway, the companion idle, and the next launch restarts the
///   agent from the new app (`outdated`).
@MainActor final class UpdateQuit {
    enum Unregister { case done, timedOut, refused }
    struct Effects {
        var ask: () async -> UpdateGate.Decision
        var unregister: () async -> Unregister
        var waitForJobGone: () async -> Void
        var record: (String) -> Void
        /// Returns once the companion is idle, or when the task is cancelled.
        var waitUntilIdle: () async -> Void
        /// Shows the waiting sentence with OK and Don't Quit, which calls the given closure.
        var showWaiting: (@escaping () -> Void) -> Void
        var closeWaiting: () -> Void
        var terminate: () -> Void
    }
    private let effects: Effects
    private var autoQuit: Task<Void, Never>?
    /// The last auto-quit, for tests to wait on.
    private(set) var lastAutoQuit: Task<Void, Never>?
    private var quittingByItself = false

    init(effects: Effects) { self.effects = effects }

    /// Whether the app may quit now.
    func shouldTerminate() async -> Bool {
        if quittingByItself {
            quittingByItself = false
        } else if await effects.ask() == .wait {
            refuse()
            return false
        }
        switch await effects.unregister() {
        case .done, .timedOut:
            effects.record("stopped")
            await effects.waitForJobGone()
        case .refused:
            effects.record("outdated")
        }
        return true
    }

    private func refuse() {
        effects.closeWaiting()
        effects.showWaiting { [weak self] in self?.callOff() }
        guard autoQuit == nil else { return }
        let task = Task { @MainActor [weak self] in
            await self?.effects.waitUntilIdle()
            guard let self, self.autoQuit != nil, !Task.isCancelled else { return }
            self.autoQuit = nil
            self.effects.closeWaiting()
            self.quittingByItself = true
            self.effects.terminate()
        }
        autoQuit = task
        lastAutoQuit = task
    }

    /// Don't Quit: the app stays open; the update installs at a later quit.
    func callOff() {
        autoQuit?.cancel()
        autoQuit = nil
        effects.closeWaiting()
    }
}

/// #850: an app replaced by hand (the only way off beta 6) leaves the old app's companion running, and both say
/// companion 0.1.0. At launch the app asks which build launched the companion (`status.get`'s `appBuild`, missing from
/// every companion before #850) and restarts the LaunchAgent when it isn't this one, so it runs this app's payload. A
/// working companion is restarted only once idle (the update gate, with its waiting sentence); one that doesn't come
/// back as this build is said plainly instead of leaving Settings › Printers spinning.
@MainActor final class CompanionBuildCheck {
    enum Outcome: Equatable { case current, restarted, notRunning, didNotComeBack, otherCopy }
    /// What status.get says launched the companion: `appBuild` and `appPayload`, both nil before #850.
    struct Reported: Equatable { var build: String?; var payload: String? }
    static let didNotComeBack = "Counterpart couldn’t restart in the background after this update. Restart this Mac, then open Counterpart."
    /// Review F1: the agent belongs to another installed copy, and `kickstart -k` would relaunch that copy, not this one.
    static func otherCopy(_ payload: String, home: String = NSHomeDirectory()) -> String {
        var folder = URL(fileURLWithPath: payload).standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().path
        if folder == home || folder.hasPrefix(home + "/") { folder = "~" + folder.dropFirst(home.count) }
        return "Another copy of Counterpart, in \(folder), runs in the background. Open that one, or remove the extra copy."
    }
    /// About two minutes, under load, for a restarted companion to answer as this build (review F3).
    static let pauseSeconds = 2.0
    static let attempts = 60
    /// Asks (`pause` apart, about 30 s) of a companion that answers status.get with a refusal before it is taken as a
    /// build from before #850.
    static let refusedAttempts = 15
    /// Asks after `kickstart -k` before it is taken not to have restarted it and the agent is sent SIGTERM instead.
    static let kickstartAttempts = 10
    enum Restart: Equatable {
        /// `launchctl kickstart -k`: launchd stops the job and starts it again from the bundle on disk.
        case kickstart
        /// `launchctl kill SIGTERM`: the agent ends, and launchd (KeepAlive) starts it again from the bundle on disk.
        case terminate
    }
    struct Effects {
        /// status.get's `appBuild` and `appPayload`, or why it didn't answer.
        var status: () async -> Result<Reported, Error>
        var ask: () async -> UpdateGate.Decision
        /// Waits, saying so, until the companion is idle.
        var waitUntilIdle: () async -> Void
        /// Restarts the companion's LaunchAgent; nil when it worked, else what launchctl said.
        var restart: (Restart) async -> String?
        /// `pauseSeconds`.
        var pause: () async -> Void
        var say: (String) -> Void
        /// #850: every decision, for the unified log (`com.scantomake.mac`, `companion-build-check`).
        var note: (String) -> Void = { _ in }
    }
    let appBuild: String, appPayload: String
    private let effects: Effects
    init(appBuild: String, appPayload: String, effects: Effects) { self.appBuild = appBuild; self.appPayload = appPayload; self.effects = effects }

    private static func same(_ a: String, _ b: String) -> Bool {
        let path = { (p: String) in URL(fileURLWithPath: p).standardizedFileURL.resolvingSymlinksInPath().path }
        return path(a) == path(b)
    }
    private static func describe(_ answer: Result<Reported, Error>) -> String {
        switch answer {
        case .success(let r): return "appBuild=\(r.build ?? "none") appPayload=\(r.payload ?? "none")"
        case .failure(let error): return "no answer (\(String(describing: error)))"
        }
    }

    func run() async -> Outcome {
        let note = effects.note
        note("started: app build \(appBuild), payload \(appPayload)")
        // No answer at all (no socket, a timeout): two tries (review F2), then the usual start (pairing, readiness) deals
        // with it. A refusal is an answer from a running companion (#850: beta 6's refused status.get while the new app
        // minted its pairing code), so it is asked for longer, and one that keeps refusing is taken as a build from before
        // #850: a current companion never refuses status.get.
        var first = await effects.status()
        note("status.get: \(Self.describe(first))")
        var asks = 1
        while case .failure(let error) = first, asks < (error is ControlRemoteError ? Self.refusedAttempts : 2) {
            await effects.pause()
            first = await effects.status()
            asks += 1
            note("status.get again (\(asks)): \(Self.describe(first))")
        }
        let running: Reported
        switch first {
        case .success(let reported): running = reported
        case .failure(let error) where error is ControlRemoteError:
            note("it answers but refuses status.get after \(asks) asks; taken as a build from before #850")
            running = Reported(build: nil, payload: nil)
        case .failure:
            note("result: notRunning")
            return .notRunning
        }
        if let payload = running.payload, !Self.same(payload, appPayload) {
            note("another installed copy runs the companion (\(payload)); not restarted")
            effects.say(Self.otherCopy(payload))
            note("result: otherCopy")
            return .otherCopy
        }
        if running.build == appBuild { note("build matches; result: current"); return .current }
        note("build differs (\(running.build ?? "none") ≠ \(appBuild)); asking whether it is working")
        let decision = await effects.ask()
        note("update gate: \(decision)")
        if decision == .wait {
            note("busy: waiting, with the waiting sentence, until it is idle")
            await effects.waitUntilIdle()
            note("idle")
        }
        var method = Restart.kickstart
        var failure = await effects.restart(method)
        note("restart \(method): \(failure.map { "failed: \($0)" } ?? "ok")")
        if failure != nil {
            method = .terminate
            failure = await effects.restart(method)
            note("restart \(method): \(failure.map { "failed: \($0)" } ?? "ok")")
        }
        for attempt in 1...Self.attempts {
            await effects.pause()
            let now = await effects.status()
            if case .success(let reported) = now, reported.build == appBuild {
                note("result: restarted, status.get \(Self.describe(now)) after \(attempt) asks")
                return .restarted
            }
            // kickstart said it worked but the old build still answers: end the agent instead (KeepAlive starts it again).
            if method == .kickstart, attempt == Self.kickstartAttempts {
                note("still \(Self.describe(now)) after kickstart; sending SIGTERM")
                method = .terminate
                let failed = await effects.restart(method)
                note("restart \(method): \(failed.map { "failed: \($0)" } ?? "ok")")
            }
        }
        effects.say(Self.didNotComeBack)
        note("result: didNotComeBack")
        return .didNotComeBack
    }
}

/// #829: macOS runs an app opened straight from a quarantined download from a read-only copy
/// (`/private/var/folders/…/AppTranslocation/…`). From there the companion can't be registered, and Sparkle refuses
/// to update. Sparkle's own test is the same path check (`SUHost.isRunningTranslocated`).
enum Translocation {
    static let sentence = "Move Counterpart to Applications, then open it again."

    static func isTranslocated(_ bundleURL: URL) -> Bool {
        bundleURL.path.range(of: "/AppTranslocation/") != nil
    }

    /// Where the person's own copy is (Downloads, usually), from Security.framework's
    /// `SecTranslocateCreateOriginalPathForURL`, which has no public header; nil when it can't say.
    static func originalURL(of bundleURL: URL) -> URL? {
        typealias Original = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        guard isTranslocated(bundleURL),
              let security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY) else { return nil }
        defer { dlclose(security) }
        guard let symbol = dlsym(security, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        let original = unsafeBitCast(symbol, to: Original.self)
        guard let url = original(bundleURL as CFURL, nil)?.takeRetainedValue() as URL?,
              !isTranslocated(url), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
}
