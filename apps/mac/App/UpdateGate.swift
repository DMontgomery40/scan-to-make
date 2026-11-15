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
    /// The companion's LaunchAgent process, from `launchctl print` and the process table.
    struct Agent: Equatable {
        var pid: Int32
        var started: Date
        /// Its executable (`proc_pidpath`); nil when it can't be read.
        var executable: String?
        /// Whether that file is still there: an app replaced by hand leaves the old process running a deleted file.
        var executableExists: Bool
    }
    static let didNotComeBack = "Counterpart couldn’t restart in the background after this update. Restart this Mac, then open Counterpart."
    /// Review F1: the agent belongs to another installed copy, and `kickstart -k` would relaunch that copy, not this one.
    static func otherCopy(_ payload: String, home: String = NSHomeDirectory()) -> String {
        let folder = URL(fileURLWithPath: payload).standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().path
        return "Another copy of Counterpart, in \(short(folder, home: home)), runs in the background. Open that one, or remove the extra copy."
    }
    /// A path with the home folder as `~`, for the person and for public log lines (review of #854, F6).
    static func short(_ path: String, home: String = NSHomeDirectory()) -> String {
        path == home || path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
    /// About two minutes, under load, for a restarted companion to answer as this build (review F3).
    static let pauseSeconds = 2.0
    static let attempts = 60
    /// Asks (`pause` apart, about 30 s) of a companion refusing status.get as `unavailable` (#850: beta 6 does, right
    /// after the new app opens) before the process itself is looked at. `busy` and timeouts end after two, as no answer.
    static let refusedAttempts = 15
    /// Asks after `kickstart -k` before the old companion, if it is positively still there, is sent SIGTERM instead.
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
        /// The LaunchAgent's process, or nil when launchd has none running.
        var agent: () async -> Agent?
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
    /// This app's bundle, and when it was put on disk (`installedAt`): a companion process running from this bundle's path
    /// that started before that was started by the copy it replaced (review of #854, F2), whatever it answers.
    let appBundle: String, installedAt: Date?
    private let effects: Effects
    init(appBuild: String, appPayload: String, appBundle: String, installedAt: Date?, effects: Effects) {
        self.appBuild = appBuild; self.appPayload = appPayload; self.appBundle = appBundle; self.installedAt = installedAt; self.effects = effects
    }

    /// When this app was put on disk: the later inode change time (`st_ctime`) of `Contents/Info.plist` and the main
    /// executable. Copying, unzipping or a Finder replace always sets it and none can keep an older one, unlike the
    /// modification and birth times, which ditto, Archive Utility and Finder keep from the build (review of #854, F2).
    static func installedAt(bundle: String, executable: String) -> Date? {
        let times = [bundle + "/Contents/Info.plist", executable].compactMap { path -> Date? in
            var info = stat()
            guard stat(path, &info) == 0 else { return nil }
            return Date(timeIntervalSince1970: TimeInterval(info.st_ctimespec.tv_sec) + TimeInterval(info.st_ctimespec.tv_nsec) / 1e9)
        }
        return times.max()
    }


    private static func standard(_ p: String) -> String { URL(fileURLWithPath: p).standardizedFileURL.resolvingSymlinksInPath().path }
    private static func same(_ a: String, _ b: String) -> Bool { standard(a) == standard(b) }
    private func describe(_ answer: Result<Reported, Error>) -> String {
        switch answer {
        case .success(let r): return "appBuild=\(r.build ?? "none") appPayload=\(r.payload.map { Self.short($0) } ?? "none")"
        case .failure(let error): return "no answer (\(String(describing: error)))"
        }
    }
    private func describe(_ agent: Agent?) -> String {
        guard let agent else { return "none running" }
        let when = installedAt.map { "\(agent.started < $0 ? "before" : "after") this app's bundle ctime \(Self.time($0))" } ?? "bundle ctime unknown"
        return "pid \(agent.pid), started \(Self.time(agent.started)), \(when), executable \(agent.executable.map { Self.short($0) } ?? "unknown")\(agent.executableExists ? "" : " (gone)"), \(runsFromThisBundle(agent) ? "this bundle's path" : "not this bundle's path")"
    }
    private static func unavailable(_ error: Error) -> Bool { (error as? ControlRemoteError)?.code == "unavailable" }
    private static func time(_ date: Date) -> String { date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true)) }
    /// Runs from this bundle's path: its executable is inside this app (the file may be gone, replaced), or in the Trash
    /// (a replaced copy moved there).
    private func runsFromThisBundle(_ agent: Agent?) -> Bool {
        guard let path = agent?.executable else { return false }
        return Self.standard(path).hasPrefix(Self.standard(appBundle) + "/") || path.contains("/.Trash/")
    }
    /// Started before this app's files were put on disk, from this bundle's path: the copy it replaced started it.
    private func stale(_ agent: Agent?) -> Bool {
        guard let agent, let installedAt, runsFromThisBundle(agent) else { return false }
        return agent.started < installedAt
    }
    /// The other installed copy whose executable the agent runs, if it runs one that is still there and isn't ours. A file
    /// that is gone or in the Trash is an older copy of this app, replaced.
    private func otherCopyBundle(_ agent: Agent?) -> String? {
        guard let path = agent?.executable, agent?.executableExists == true, !path.contains("/.Trash/") else { return nil }
        let exe = Self.standard(path), ours = Self.standard(appBundle)
        guard !exe.hasPrefix(ours + "/"), let app = exe.range(of: ".app/", options: .backwards) else { return nil }
        return String(exe[..<app.lowerBound]) + ".app"
    }

    func run() async -> Outcome {
        let note = effects.note
        note("started: app build \(appBuild), bundle \(Self.short(appBundle)), bundle ctime \(installedAt.map { Self.time($0) } ?? "unknown")")
        var first = await effects.status()
        note("status.get: \(describe(first))")
        var asks = 1
        while case .failure(let error) = first, asks < (Self.unavailable(error) ? Self.refusedAttempts : 2) {
            await effects.pause()
            first = await effects.status()
            asks += 1
            note("status.get again (\(asks)): \(describe(first))")
        }
        let agent = await effects.agent()
        note("agent: \(describe(agent))")
        // Re-check of #854, R1: an agent running another installed copy's executable is that copy's, whatever it answers.
        if let other = otherCopyBundle(agent) {
            note("another installed copy runs the companion (\(Self.short(other))); not restarted")
            effects.say(Self.otherCopy(other + "/Contents/Resources/Payload")); note("result: otherCopy"); return .otherCopy
        }
        switch first {
        case .success(let running):
            if let payload = running.payload, !Self.same(payload, appPayload) {
                note("another installed copy runs the companion (\(Self.short(payload))); not restarted")
                effects.say(Self.otherCopy(payload)); note("result: otherCopy"); return .otherCopy
            }
            if running.build == appBuild { note("build matches; result: current"); return .current }
            note("evidence: it answers with build \(running.build ?? "none"), not \(appBuild)")
        case .failure:
            // No answer is no evidence by itself (a current companion can refuse under load, or still be starting).
            guard stale(agent) else { note("no evidence it is another build; result: notRunning"); return .notRunning }
            note("evidence: its process started before this app's bundle ctime, from this bundle's path")
        }
        await waitWhileBusy()
        let failure = await effects.restart(.kickstart)
        note("restart kickstart: \(failure.map { "failed: \($0)" } ?? "ok")")
        var terminated = false
        if failure != nil { terminated = await terminateIfStillOld(agent) }
        for attempt in 1...Self.attempts {
            await effects.pause()
            let now = await effects.status()
            if case .success(let reported) = now {
                // As at the start (re-check of #854, R2): another copy's answer first, then the build.
                if let payload = reported.payload, !Self.same(payload, appPayload) {
                    note("another installed copy answers now (\(Self.short(payload))); result: otherCopy")
                    effects.say(Self.otherCopy(payload)); return .otherCopy
                }
                if reported.build == appBuild {
                    note("result: restarted, status.get \(describe(now)) after \(attempt) asks"); return .restarted
                }
            }
            // A kickstart that changed nothing: SIGTERM, only if the old companion is positively still the one there.
            if !terminated, attempt == Self.kickstartAttempts {
                note("after kickstart: status.get \(describe(now))")
                terminated = await terminateIfStillOld(agent)
            }
        }
        effects.say(Self.didNotComeBack)
        note("result: didNotComeBack")
        return .didNotComeBack
    }

    private func waitWhileBusy() async {
        let decision = await effects.ask()
        effects.note("update gate: \(decision)")
        guard decision == .wait else { return }
        effects.note("busy: waiting, with the waiting sentence, until it is idle")
        await effects.waitUntilIdle()
        effects.note("idle")
    }

    /// Review of #854, F1: SIGTERM only with positive evidence the old companion is still the one running (it answers
    /// with another build, or the same stale process is still there), never another copy's, and only once the gate says
    /// it isn't working. Re-check R3: the evidence first, then the gate, then the build once more just before the signal.
    private func terminateIfStillOld(_ before: Agent?) async -> Bool {
        let now = await effects.status(), agent = await effects.agent()
        effects.note("before SIGTERM: status.get \(describe(now)); agent \(describe(agent))")
        if otherCopyBundle(agent) != nil { effects.note("another installed copy's companion; no SIGTERM"); return false }
        var answersOld = false
        if case .success(let reported) = now {
            if let payload = reported.payload, !Self.same(payload, appPayload) { effects.note("another installed copy answers; no SIGTERM"); return false }
            answersOld = reported.build != appBuild
        }
        let sameStale = agent != nil && agent?.pid == before?.pid && stale(agent)
        guard answersOld || sameStale else { effects.note("no evidence the old companion is still there; no SIGTERM"); return false }
        await waitWhileBusy()
        if case .success(let reported) = await effects.status(), reported.build == appBuild {
            effects.note("it answers as this build now; no SIGTERM"); return false
        }
        let failure = await effects.restart(.terminate)
        effects.note("restart terminate: \(failure.map { "failed: \($0)" } ?? "ok")")
        return true
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
