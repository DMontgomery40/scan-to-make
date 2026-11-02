import CloudKit
import CounterpartKit
import Observation

/// Reads the Mac's private database without requiring query indexes for discovery. Enrollment tokens
/// remain in memory, and account changes discard the previous account's records and change token.
@MainActor @Observable final class MobileCloud {
    private(set) var macs: [CloudMac] = []
    private(set) var message: String?
    private(set) var reading = false
    private(set) var printUpdates: [PrintActivitySnapshot] = []
    private var database: CKDatabase?
    private var token: CKServerChangeToken?
    private var records: [CKRecord.ID: CKRecord] = [:]
    private var accountID: CKRecord.ID?
    private var subscribed: Bool?
    private(set) var alertsMessage = "Connect to your Mac to check your saved notification choices."

    static var configured: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        #if DEBUG
        if Fixtures.folder != nil { return false }
        #endif
        return Bundle.main.object(forInfoDictionaryKey: "CounterpartCloudEnabled") as? Bool == true
        #endif
    }

    func refresh() async {
        guard !reading else { return }
        guard Self.configured else { message = "This build isn't signed for iCloud. You can still pair with your Mac's code."; return }
        reading = true; defer { reading = false }
        do {
            let container = CKContainer(identifier: CounterpartIdentifiers.cloudKitContainer)
            guard try await container.accountStatus() == .available else {
                clear(); message = "Sign in to the same Apple Account on this iPhone and your Mac, or use your Mac's code."
                return
            }
            let current = try await container.userRecordID()
            if accountID != current { clear(); accountID = current }
            let database = container.privateCloudDatabase; self.database = database
            do { try await readChanges(database) }
            catch let error as CKError where error.code == .changeTokenExpired {
                token = nil; records = [:]
                try await readChanges(database)
            }
            macs = records.values.filter { $0.recordType == "CounterpartMac" }.compactMap(Self.mac)
                .filter { $0.isCurrent() }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            printUpdates = records.values.filter { $0.recordType == CloudKitRecords.project }.compactMap(Self.printSnapshot)
            message = macs.isEmpty ? "Open Counterpart on your Mac. It needs the same Apple Account and a connection to iCloud." : nil
        } catch let error as CKError where error.code == .zoneNotFound || error.code == .unknownItem {
            message = "Open Counterpart on your Mac so it can make itself available in iCloud. You can also use its code."
        } catch {
            message = "iCloud couldn't be reached. Try again, or use your Mac's code."
        }
    }

    private func clear() { token = nil; records = [:]; macs = []; printUpdates = []; subscribed = nil; database = nil; accountID = nil }

    func saveActivityTokens(device: String, pushToStart: String?, activities: [String: String]) async -> Bool {
        guard Self.configured, let database else { return false }
        let record = CKRecord(recordType: CloudKitRecords.device, recordID: CKRecord.ID(recordName: device, zoneID: CloudNotificationSubscriptions.zoneID))
        record["deviceId"] = device; record["pushToStartToken"] = pushToStart
        record["activityTokens"] = activities.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }
        do {
            let result = try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .allKeys)
            for outcome in result.saveResults.values { _ = try outcome.get() }
            return true
        } catch { return false }
    }

    func configureAlerts(settings: CompanionSettings?, localChoices: [Bool]) async {
        guard let database else { return }
        // A temporarily unreachable Mac must not turn off an already configured away-from-home
        // subscription. Unknown preferences never create one; retry after a successful settings read.
        guard settings != nil else {
            alertsMessage = "Connect to your Mac to check your saved notification choices. Existing iCloud alerts keep their last configuration."
            return
        }
        let enabled = CloudNotificationSubscriptions.alertsAllowed(settings: settings, localChoices: localChoices)
        alertsMessage = enabled ? "iCloud alerts include every event type." : "iCloud alerts are paused because saved choices are off or couldn't be checked. Individual iPhone alert types aren't supported yet."
        guard subscribed != enabled else { return }
        let all = CloudNotificationSubscriptions.make()
        let saving = enabled ? all : all.filter { $0.subscriptionID == "proj-silent" }
        let deleting = enabled ? [] : all.filter { $0.subscriptionID != "proj-silent" }.map(\.subscriptionID)
        do {
            let result = try await database.modifySubscriptions(saving: saving, deleting: deleting)
            for outcome in result.saveResults.values { _ = try outcome.get() }
            for outcome in result.deleteResults.values {
                if case .failure(let error) = outcome, (error as? CKError)?.code != .unknownItem { throw error }
            }
            subscribed = enabled
        } catch { alertsMessage = "iCloud couldn't update alerts. Open Counterpart again when connected to check your choices." }
    }

    private func readChanges(_ database: CKDatabase) async throws {
        var more = true
        while more {
            try Task.checkCancellation()
            let page = try await database.recordZoneChanges(inZoneWith: CloudNotificationSubscriptions.zoneID, since: token,
                desiredKeys: ["macId", "name", "addresses", "spkiSha256", "enrolmentToken", "tokenExpiresAt",
                    "projectId", "printId", "title", "printerName", "printState", "progress", "remainingSec", "endsAt", "updatedAt"], resultsLimit: 200)
            // Do not advance past a record-level failure; the next attempt must see it again.
            let changed = try page.modificationResultsByID.map { (id, result) in (id, try result.get().record) }
            for (id, record) in changed where ["CounterpartMac", CloudKitRecords.project].contains(record.recordType) { records[id] = record }
            for deletion in page.deletions { records[deletion.recordID] = nil }
            token = page.changeToken; more = page.moreComing
        }
    }

    private static func printSnapshot(_ record: CKRecord) -> PrintActivitySnapshot? {
        guard let project = record["projectId"] as? String, let print = record["printId"] as? String,
              let state = record["printState"] as? String else { return nil }
        let updated = record["updatedAt"] as? Date ?? Date()
        return .init(attributes: .init(projectId: project, printId: print, title: record["title"] as? String ?? "Your print", printerName: record["printerName"] as? String ?? "Your printer"),
            content: .init(state: state, progress: (record["progress"] as? NSNumber)?.doubleValue ?? 0,
                           endsAt: record["endsAt"] as? Date ?? updated.addingTimeInterval((record["remainingSec"] as? NSNumber)?.doubleValue ?? 0)), observedAt: updated)
    }

    private static func mac(_ record: CKRecord) -> CloudMac? {
        guard let id = record["macId"] as? String, let name = record["name"] as? String,
              let addresses = record["addresses"] as? String, let pin = record["spkiSha256"] as? String,
              let token = record["enrolmentToken"] as? String, let expires = record["tokenExpiresAt"] as? Date else { return nil }
        return CloudMac(id: id, name: name, addressesJSON: addresses, publicKeySha256: pin, enrolmentToken: token, expiresAt: expires)
    }
}
