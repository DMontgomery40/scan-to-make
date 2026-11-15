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
                let answeredBadly = error is ControlRemoteError
                    || [.timedOut, .invalidResponse].contains(error as? ControlClientError)
                guard answeredBadly else { unansweredSince = nil; return .install }
                let since = unansweredSince ?? now
                unansweredSince = since
                return now.timeIntervalSince(since) >= Self.limit ? .install : .wait
            }
        }
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
