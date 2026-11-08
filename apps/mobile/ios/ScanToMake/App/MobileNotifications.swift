import UIKit
import UserNotifications
import CloudKit
import CounterpartKit

/// Owns notification registration and routing, including a tap that launched the app before SwiftUI
/// attached its model. The system permission is requested by the existing onboarding/settings UI.
///
/// The buttons (PRD §9.1, §9.2) come from `NotificationActions`. Background ones (It Works, Needs Changes…,
/// Ask for Changes…, Best Guess, Pause, Resume) make the same companion call as the app's own buttons, or, when
/// the Mac can't be reached at all, write the same command to iCloud (§9.3). The others open the app.
@MainActor final class MobileNotifications: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private weak var app: AppModel?
    private var pending: AppRoute?
    /// For a button pressed while no window exists yet (iOS launched the app in the background for it).
    private lazy var standalone: CompanionClient = AppModel.clients().1

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationActions.categories())
        return true
    }

    func attach(_ app: AppModel) {
        self.app = app
        if let pending { self.pending = nil; app.route = pending }
        if MobileCloud.configured { UIApplication.shared.registerForRemoteNotifications() }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard CKNotification(fromRemoteNotificationDictionary: userInfo) != nil, let app else {
            completionHandler(.noData); return
        }
        Task {
            await app.cloud.refresh()
            // CloudKit changes supply the mirrored progress during the background runtime. Never
            // start an activity here or wait for a LAN connection while the phone is away.
            await app.activities.reconcile(app.cloud.printUpdates, mayStart: false)
            completionHandler(.newData)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let fields = AppRoute.notificationFields(content.userInfo)
        let action = response.actionIdentifier
        if NotificationActions.Action(rawValue: action)?.background == true {
            // Never opens a screen. The request is made before this returns, so iOS keeps the app running for it.
            guard let command = NotificationActions.command(action: action, type: fields.type ?? "", projectId: fields.projectId ?? "",
                                                            text: (response as? UNTextInputNotificationResponse)?.userText) else { return }
            await run(command, title: content.title)
            return
        }
        guard let route = AppRoute(notification: content.userInfo, action: action) else { return }
        await MainActor.run {
            if let app = self.app {
                app.route = route
            } else { self.pending = route }
        }
    }

    /// While the app is open, a notification shows unless the screen already shows its project: that project's
    /// page or its Printing screen (PRD §9.2: suppress only what the app already showed). Anywhere else (Home,
    /// Settings, another project's Print sheet) it shows as a banner.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let project = AppRoute.notificationFields(notification.request.content.userInfo).projectId
        let showing = await MainActor.run { project.map { self.app?.onScreen[$0] != nil } ?? false }
        return showing ? [] : [.banner, .list, .sound]
    }

    // MARK: Background buttons

    /// Over the paired connection when the Mac answers; through iCloud only when it can't be reached at all, never
    /// after it took the request (a retry there could start a second change). A failure is said in a notification.
    private func run(_ command: NotificationActions.Command, title: String) async {
        let client = app?.companion ?? standalone
        let failure: String?
        if await client.answers() {
            do {
                let updated = try await command.run(client)
                if let updated, let store = app?.projects { store.replace(updated, ticket: store.startRequest()) }
                failure = nil
            } catch let error as CompanionError {
                failure = error.needsPairing ? "Open Counterpart to connect to your Mac again." : error.message
            } catch { failure = CompanionError.unreachable.message }
        } else if await MobileCloud.send(command.cloudCommands, projectId: command.projectId) {
            failure = nil
        } else {
            failure = MobileCloud.configured ? "Your Mac isn't answering, and iCloud couldn't take it. Open Counterpart to try again."
                : CompanionError.unreachable.message
        }
        guard let failure else { return }
        let notice = UNMutableNotificationContent()
        notice.title = "\(command.failedWords): \(title)"
        notice.body = failure
        notice.categoryIdentifier = NotificationActions.Category.problem.rawValue
        notice.threadIdentifier = command.projectId
        notice.userInfo = ["projectId": command.projectId]
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "action-failed-\(command.projectId)", content: notice, trigger: nil))
    }
}
