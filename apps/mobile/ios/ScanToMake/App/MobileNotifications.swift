import UIKit
import UserNotifications
import CloudKit
import CounterpartKit

/// Owns notification registration and routing, including a tap that launched the app before SwiftUI
/// attached its model. The system permission is requested by the existing onboarding/settings UI.
@MainActor final class MobileNotifications: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private weak var app: AppModel?
    private var pending: AppRoute?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let printAction = UNNotificationAction(identifier: "PRINT", title: "Print", options: .foreground)
        let camera = UNNotificationAction(identifier: "CAMERA", title: "Take a Photo", options: .foreground)
        let open = UNNotificationAction(identifier: "OPEN", title: "Open Project", options: .foreground)
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "READY", actions: [printAction, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "ASK", actions: [camera, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "CONFIRM", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "PROGRESS", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "DONE", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "PROBLEM", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SOFTWARE", actions: [], intentIdentifiers: []),
        ])
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
            // Reconcile from the source; CloudKit can omit fields and coalesce pushes.
            if !app.needsMac { await app.projects.load() }
            completionHandler(.newData)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let route = AppRoute(notification: response.notification.request.content.userInfo, action: response.actionIdentifier) else { return }
        await MainActor.run {
            if let app = self.app {
                app.route = route
            } else { self.pending = route }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // The foreground UI follows the same event through its long poll. Do not add a second banner.
        []
    }
}
