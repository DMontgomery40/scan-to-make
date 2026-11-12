import Foundation
import XCTest
@testable import CounterpartKit

/// The phone's own library of what it has shown (docs/design/overhaul/on-device-library.md). David, Nov 11: "Never seen app
/// in my life, since 2009 or so, struggle showing images it just had, 10 minutes later, because of a dependency on some Mac
/// mini". The bug: pictures lived in Caches keyed by version and were fetched only when a page asked, so a page with the Mac
/// away showed a symbol. These cover the library's index, replacement after arrival, eviction order, clearing, and the
/// link rules.
final class OnDeviceLibraryTests: XCTestCase {
    private var base: URL!

    override func setUp() {
        base = FileManager.default.temporaryDirectory.appending(path: "library-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        UserDefaults.standard.removeObject(forKey: OnDeviceLibrary.Keep.defaultsKey)
    }
    override func tearDown() {
        try? FileManager.default.removeItem(at: base)
        UserDefaults.standard.removeObject(forKey: OnDeviceLibrary.Keep.defaultsKey)
    }

    private func arrived(_ text: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "arrived-\(UUID().uuidString)")
        try Data(text.utf8).write(to: url)
        return url
    }

    private func sized(_ bytes: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "arrived-\(UUID().uuidString)")
        try Data(count: bytes).write(to: url)
        return url
    }

    private static let id = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
    private func project(_ id: String = OnDeviceLibraryTests.id, ended: Int, extra: String = "") -> Project {
        try! JSONDecoder().decode(Project.self, from: Data(#"{"id":"\#(id)","createdAtMs":1,"updatedAtMs":2,"state":"ready","kind":"fit","photos":[],"passes":[{"startedAtMs":1,"endedAtMs":\#(ended),"status":"done"}],"current":{"model":"current/model.stl","renders":[]},"picture":"pictures/part-0123456789abcdef.png","pictures":{"part":"pictures/part-0123456789abcdef.png"}\#(extra)}"#.utf8))
    }

    private func client(_ fake: FakeTransport, library: OnDeviceLibrary) throws -> CompanionClient {
        let store = PairingStore(store: MemoryStore(), defaults: UserDefaults(suiteName: "lib-\(UUID().uuidString)")!)
        try store.save(v2Record(), notify: false)
        let cache = FileManager.default.temporaryDirectory.appending(path: "counterpart-tests-\(UUID().uuidString)")
        return CompanionClient(pairing: PairingClient(store: store, transport: fake), transport: fake, deviceModel: "iPhone18,2", cache: cache, library: library)
    }

    // MARK: The index

    func testTheIndexSurvivesARelaunchAndDropsFilesThatAreGone() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "https://mac:9077")
        let picture = try library.commit(try arrived("png"), project: Self.id, name: "pictures/a.png", version: 10, file: "pictures_a.png")
        let model = try library.commit(try arrived("stl"), project: Self.id, name: "model.stl", version: 10, file: "model.stl")
        library.opened(Self.id, at: Date(timeIntervalSince1970: 5))
        XCTAssertTrue(picture.path.hasPrefix(base.path), "Application Support's library, not Caches")

        // A relaunch: a new library object reads the same index.
        let again = OnDeviceLibrary(base: base)
        again.use(mac: "https://mac:9077")
        XCTAssertEqual(again.file(project: Self.id, name: "pictures/a.png", version: 10), picture)
        XCTAssertEqual(again.latest(project: Self.id, name: "model.stl")?.version, 10)
        XCTAssertEqual(again.lastOpened(Self.id), Date(timeIntervalSince1970: 5))
        XCTAssertEqual(again.usage, 6)
        XCTAssertNil(again.file(project: Self.id, name: "model.stl", version: 11), "another version of a model is not this one")
        XCTAssertEqual(again.file(project: Self.id, name: "pictures/a.png", version: 11), picture, "a Mac picture's name is its content")

        // A file removed outside the library leaves no entry behind.
        try FileManager.default.removeItem(at: model)
        let third = OnDeviceLibrary(base: base)
        third.use(mac: "https://mac:9077")
        XCTAssertNil(third.latest(project: Self.id, name: "model.stl"))
        XCTAssertEqual(third.entries.count, 1)
    }

    func testTheLibraryIsExcludedFromBackup() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "https://mac:9077")
        try library.commit(try arrived("png"), project: Self.id, name: "pictures/a.png", version: 1, file: "a.png")
        XCTAssertEqual(try base.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    // MARK: Replacement after arrival

    /// The bug, through the client: the Mac answers once; then it is away and the list says a newer version. The page
    /// draws the copy it has at once (`stored`), and the newer one replaces it only when it has fully arrived.
    func testANewerVersionReplacesTheOldOnlyAfterItHasFullyArrived() async throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "https://mac:9077")
        var away = false
        let fake = FakeTransport { _, _ in
            if away { throw TransportError("network") }
            return HTTPReply(status: 200, body: Data("first".utf8))
        }
        let c = try client(fake, library: library)
        let v1 = project(ended: 1000), v2 = project(ended: 2000)
        let first = try await c.download(v1, "renders/front.png")
        XCTAssertTrue(first.path.hasPrefix(base.path))

        // A relaunch with the Mac away: the same version is a library hit, with no request at all.
        away = true
        let calls = fake.calls.count
        let again = try await c.download(v1, "renders/front.png")
        XCTAssertEqual(again, first)
        XCTAssertEqual(fake.calls.count, calls, "a kept file never asks the Mac")

        // A newer version listed while the Mac is away: the old copy is what the screen draws, and it stays.
        do { _ = try await c.download(v2, "renders/front.png"); XCTFail("the Mac is away") } catch {}
        XCTAssertEqual(c.stored(v2, "renders/front.png"), first)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path), "a failed fetch never removes the copy on screen")

        // The Mac answers: the new one lands whole, then the old file goes.
        away = false
        fake.answer = { _, _ in HTTPReply(status: 200, body: Data("second".utf8)) }
        let second = try await c.download(v2, "renders/front.png")
        XCTAssertNotEqual(second, first)
        XCTAssertEqual(try String(contentsOf: second, encoding: .utf8), "second")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(c.stored(v2, "renders/front.png"), second)
    }

    // MARK: Never twice (#720)

    /// David, Nov 11: "if i just saw it 2 seconds ago, how is it having to come from my mac again?" A Mac picture is named
    /// by what it draws, so a newer project version (a finished pass, a print) is the same picture: no request at all.
    func testAMacPictureIsTheSameFileAtEveryProjectVersionAndNeverAsksTheMacAgain() async throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: Data("png".utf8), headers: ["ETag": "\"p1\""]) }
        let c = try client(fake, library: library)
        let first = try await c.download(project(ended: 1000), "pictures/part-0123456789abcdef.png")
        let calls = fake.calls.count
        let later = try await c.download(project(ended: 2000), "pictures/part-0123456789abcdef.png")
        XCTAssertEqual(later, first)
        XCTAssertEqual(fake.calls.count, calls, "the same picture name is never fetched again")
        XCTAssertNotNil(library.file(project: Self.id, name: "pictures/part-0123456789abcdef.png", version: 5000), "at any version")
    }

    /// A completed pass changes the project's version, not its model's bytes: the phone asks with the Mac's tag, the Mac
    /// answers 304, and the kept file (same path, so the drawn mesh and still are reused) is this version's. Bytes come once.
    func testAnUnchangedModelIsNotDownloadedTwice() async throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        var bodies = 0
        var asked: [String?] = []
        let fake = FakeTransport { request, _ in
            let tag = request.value(forHTTPHeaderField: "If-None-Match")
            asked.append(tag)
            if tag == "\"m1\"" { return HTTPReply(status: 304, body: Data(), headers: ["ETag": "\"m1\""]) }
            bodies += 1
            return HTTPReply(status: 200, body: Data("solid".utf8), headers: ["ETag": "\"m1\""])
        }
        let c = try client(fake, library: library)
        let first = try await c.download(project(ended: 1000), "model.stl")
        let second = try await c.download(project(ended: 2000), "model.stl")
        XCTAssertEqual(second, first, "the same file on disk")
        XCTAssertEqual(bodies, 1, "the model's bytes came once")
        XCTAssertEqual(asked, [nil, "\"m1\""])
        XCTAssertEqual(library.latest(project: Self.id, name: "model.stl")?.version, Int64(project(ended: 2000).mediaVersion))
        // Asked again at the version it now has: a library hit, no request.
        _ = try await c.download(project(ended: 2000), "model.stl")
        XCTAssertEqual(fake.calls.count, 2)
        // The bytes change: they come, under the new tag.
        fake.answer = { _, _ in HTTPReply(status: 200, body: Data("newer".utf8), headers: ["ETag": "\"m2\""]) }
        let third = try await c.download(project(ended: 3000), "model.stl")
        XCTAssertEqual(try String(contentsOf: third, encoding: .utf8), "newer")
    }

    /// The same for a file the library doesn't keep (a scan under "Pictures and 3D models"): its tag sits beside it in the
    /// cache, and a newer version moves the unchanged copy instead of fetching it.
    func testAnUnchangedFileTheLibraryDoesNotKeepIsNotDownloadedTwice() async throws {
        OnDeviceLibrary.Keep.chosen = .pictures
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        var bodies = 0
        let fake = FakeTransport { request, _ in
            if request.value(forHTTPHeaderField: "If-None-Match") == "\"s1\"" { return HTTPReply(status: 304, body: Data()) }
            bodies += 1
            return HTTPReply(status: 200, body: Data("stl".utf8), headers: ["ETag": "\"s1\""])
        }
        let c = try client(fake, library: library)
        let first = try await c.download(project(ended: 1000), "model.stl")
        XCTAssertFalse(first.path.hasPrefix(base.path))
        let second = try await c.download(project(ended: 2000), "model.stl")
        XCTAssertEqual(try String(contentsOf: second, encoding: .utf8), "stl")
        XCTAssertEqual(bodies, 1, "fetched once")
    }

    /// A file fetched before its kind was kept goes into the library from the cache, with the Mac away (Cursor P2.2).
    func testACachedFileOfANowKeptKindGoesIntoTheLibraryWithoutTheMac() async throws {
        OnDeviceLibrary.Keep.chosen = .pictures
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        var away = false
        let fake = FakeTransport { _, _ in
            if away { throw TransportError("network") }
            return HTTPReply(status: 200, body: Data("stl".utf8))
        }
        let c = try client(fake, library: library)
        _ = try await c.download(project(ended: 1000), "model.stl")
        OnDeviceLibrary.Keep.chosen = .models
        away = true
        let kept = try await c.download(project(ended: 1000), "model.stl")
        XCTAssertTrue(kept.path.hasPrefix(base.path))
        XCTAssertEqual(try String(contentsOf: kept, encoding: .utf8), "stl")
    }

    /// The paired Mac's file downloads share one session (one TLS connection, reused), per pin and address; another Mac,
    /// a pairing attempt and nearby pairing never share it (#720).
    func testTheMacsFilesShareOneSessionPerPin() {
        let record = v2Record()
        let a = SessionPool.shared.session(for: .record(record), resourceTimeout: 1800)
        XCTAssertNotNil(a)
        XCTAssertTrue(a === SessionPool.shared.session(for: .record(record), resourceTimeout: 1800), "the same Mac: the same session")
        var other = record.fields; other["publicKeySha256"] = .string(String(repeating: "cd", count: 32))
        let another = PairingRecord(fields: other)
        XCTAssertFalse(a === SessionPool.shared.session(for: .record(another), resourceTimeout: 1800), "another pin: its own session")
        XCTAssertNil(SessionPool.shared.session(for: .pending(record), resourceTimeout: 1800), "a pairing attempt is never pooled")
    }

    /// Too large is per variant: another original of the same project version is still asked for (Cursor P2.1).
    func testTooLargeIsRememberedPerVariant() {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        library.markTooLarge(project: Self.id, name: "model.stl", version: 7, file: "model-aaa.3mf")
        XCTAssertTrue(library.isTooLarge(project: Self.id, name: "model.stl", version: 7, file: "model-aaa.3mf"))
        XCTAssertFalse(library.isTooLarge(project: Self.id, name: "model.stl", version: 7, file: "model-bbb.3mf"))
    }

    func testReplacingOneFileLeavesTheProjectsOtherFiles() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let model = try library.commit(try arrived("stl"), project: Self.id, name: "model.stl", version: 1, file: "model.stl")
        _ = try library.commit(try arrived("a"), project: Self.id, name: "pictures/a.png", version: 1, file: "a.png")
        _ = try library.commit(try arrived("b"), project: Self.id, name: "pictures/a.png", version: 2, file: "a.png")
        XCTAssertTrue(FileManager.default.fileExists(atPath: model.path), "a newer picture never takes the model with it")
        // A slow download of an older version that finishes late leaves the newer one in place.
        let kept = try library.commit(try arrived("old"), project: Self.id, name: "pictures/a.png", version: 1, file: "a.png")
        XCTAssertEqual(library.latest(project: Self.id, name: "pictures/a.png")?.version, 2)
        XCTAssertEqual(try String(contentsOf: kept, encoding: .utf8), "b")
    }

    func testAFileTheMacRefusesAsTooLargeIsNeverAskedForAgain() async throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let fake = FakeTransport { _, _ in json(413, ["error": ["code": "file-too-large", "message": "too large"]]) }
        let c = try client(fake, library: library)
        let p = project(ended: 1000)
        do { _ = try await c.download(p, "model.stl"); XCTFail() } catch let error as CompanionError { XCTAssertEqual(error.code, "file-too-large") }
        let calls = fake.calls.count
        do { _ = try await c.download(p, "model.stl"); XCTFail() } catch let error as CompanionError { XCTAssertEqual(error.code, "file-too-large") }
        XCTAssertEqual(fake.calls.count, calls, "remembered, not asked again")
        XCTAssertTrue(OnDeviceLibrary(base: base).then { $0.use(mac: "m") }.isTooLarge(project: p.id, name: "model.stl", version: Int64(p.mediaVersion)), "across launches")
    }

    func testKindsThePersonDoesNotKeepUseTheCacheNotTheLibrary() async throws {
        OnDeviceLibrary.Keep.chosen = .pictures
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let c = try client(FakeTransport { _, _ in HTTPReply(status: 200, body: Data("stl".utf8)) }, library: library)
        let model = try await c.download(project(ended: 1), "model.stl")
        XCTAssertFalse(model.path.hasPrefix(base.path), "pictures only: a model is fetched for the page but not kept")
        let picture = try await c.download(project(ended: 1), "pictures/part-0123456789abcdef.png")
        XCTAssertTrue(picture.path.hasPrefix(base.path))
    }

    // MARK: Eviction

    func testEvictionTakesScansThenModelsOfTheOldestOpenedProjectsAndPicturesLast() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let old = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a01", recent = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a02"
        library.opened(old, at: Date(timeIntervalSince1970: 1))
        library.opened(recent, at: Date(timeIntervalSince1970: 100))
        for id in [old, recent] {
            try library.commit(try sized(100), project: id, name: "pictures/p.png", version: 1, file: "p.png")
            try library.commit(try sized(1_000), project: id, name: "model.stl", version: 1, file: "model.stl")
        }
        try library.commit(try sized(5_000), project: recent, name: "scan/scan.usdz", version: 1, file: "scan.usdz")
        XCTAssertEqual(library.usage, 7_200)

        // Everything kept, ceiling 1,000: the scan, then the old project's model, then the recent project's model.
        let gone = library.evict(keep: .everything, ceiling: 1_000)
        XCTAssertEqual(gone.map { "\($0.kind.rawValue):\($0.project == old ? "old" : "recent")" },
                       ["scan:recent", "model:old", "model:recent"])
        XCTAssertEqual(library.usage, 200)
        XCTAssertNotNil(library.latest(project: old, name: "pictures/p.png"), "pictures stay")

        // Pictures go last, oldest-opened first.
        let more = library.evict(keep: .everything, ceiling: 150)
        XCTAssertEqual(more.map(\.project), [old])
        XCTAssertNotNil(library.latest(project: recent, name: "pictures/p.png"))
    }

    func testChoosingPicturesOnlyLetsModelsAndScansGo() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        try library.commit(try sized(10), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png")
        try library.commit(try sized(10), project: Self.id, name: "model.stl", version: 1, file: "model.stl")
        library.evict(keep: .pictures)
        XCTAssertNil(library.latest(project: Self.id, name: "model.stl"))
        XCTAssertNotNil(library.latest(project: Self.id, name: "pictures/p.png"))
    }

    // MARK: Clearing

    func testADeletedProjectsFilesGoWhenTheListNoLongerHasIt() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        let other = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a03"
        let gone = try library.commit(try arrived("a"), project: other, name: "pictures/p.png", version: 1, file: "p.png")
        try library.commit(try arrived("b"), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png")
        library.prune(keeping: [Self.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: gone.path))
        XCTAssertNil(library.latest(project: other, name: "pictures/p.png"))
        XCTAssertNotNil(library.latest(project: Self.id, name: "pictures/p.png"))
    }

    func testUnpairingOrPairingAnotherMacClearsTheLibrary() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "mac-a")
        let a = try library.commit(try arrived("a"), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png")
        library.use(mac: "mac-a")
        XCTAssertTrue(FileManager.default.fileExists(atPath: a.path), "the same Mac again keeps its files")
        library.use(mac: "mac-b")
        XCTAssertFalse(FileManager.default.fileExists(atPath: a.path), "another Mac: the old Mac's files go")
        XCTAssertNil(library.latest(project: Self.id, name: "pictures/p.png"))
        try library.commit(try arrived("b"), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png")
        library.unpair()
        XCTAssertFalse(library.isActive)
        XCTAssertFalse(FileManager.default.fileExists(atPath: base.path))
        XCTAssertNil(library.latest(project: Self.id, name: "pictures/p.png"))
    }

    func testClearEmptiesThisMacsLibraryAndKeepsWorking() throws {
        let library = OnDeviceLibrary(base: base)
        library.use(mac: "m")
        try library.commit(try arrived("a"), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png")
        library.clear()
        XCTAssertEqual(library.usage, 0)
        XCTAssertNoThrow(try library.commit(try arrived("a"), project: Self.id, name: "pictures/p.png", version: 1, file: "p.png"))
    }

    // MARK: What the fill fetches, and on which link

    func testTheFillWantsEveryProjectsPictureAndModelsForOpenedAndRecentProjects() {
        let projects = (1...5).map { project("0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a0\($0)", ended: $0 * 1000) }
        let wants = LibraryPlan.wants(projects, opened: [projects[0].id], keep: .models)
        let pictures = wants.filter { $0.kind == .picture }
        XCTAssertEqual(Set(pictures.map(\.project.id)), Set(projects.map(\.id)), "every project's picture")
        XCTAssertEqual(pictures.count, 5, "the card's and the stage's picture are one file here, fetched once")
        let models = Set(wants.filter { $0.kind == .model }.map(\.project.id))
        XCTAssertEqual(models, [projects[0].id, projects[2].id, projects[3].id, projects[4].id], "the opened one and the three most recent")
        XCTAssertEqual(wants.first?.kind, .picture, "pictures first")
        XCTAssertTrue(LibraryPlan.wants(projects, opened: [], keep: .pictures).allSatisfy { $0.kind == .picture })
        // A designer's plates: every plate's picture, for a project never opened too (#556's away proof: two pages said
        // "not available" for plates the fill had never taken).
        let plates = project(ended: 9000, extra: #","kind":"published","plates":[{"id":"0-1","fileIndex":0,"plateIndex":1,"name":"Plate 1","fileName":"a.3mf","thumbnail":"renders/plate_1.png","selected":true,"sliced":false,"status":"none"},{"id":"0-2","fileIndex":0,"plateIndex":2,"name":"Plate 2","fileName":"a.3mf","thumbnail":"renders/plate_2.png","selected":false,"sliced":false,"status":"none"}]"#)
        let names = LibraryPlan.wants([plates], opened: [], keep: .pictures).map(\.name)
        XCTAssertTrue(names.contains("renders/plate_1.png") && names.contains("renders/plate_2.png"), "\(names)")
    }

    func testTheLinkRules() {
        let p = project(ended: 1)
        let picture = LibraryPlan.Want(project: p, name: "pictures/a.png", kind: .picture, bytes: nil)
        let model = LibraryPlan.Want(project: p, name: "model.stl", kind: .model, bytes: nil)
        let smallScan = LibraryPlan.Want(project: p, name: "scan/phone-preview.usdz", kind: .scan, bytes: 4_000_000)
        let bigScan = LibraryPlan.Want(project: p, name: "scan/scan.usdz", kind: .scan, bytes: 192_000_000)
        // Wi-Fi or a cable: everything the person keeps.
        for want in [picture, model, smallScan, bigScan] {
            XCTAssertTrue(LibraryPlan.fetches(want, keep: .everything, expensive: false, constrained: false), want.name)
        }
        // Cellular (expensive) or Low Data Mode (constrained): pictures, and only what is known to be small.
        for (expensive, constrained) in [(true, false), (false, true), (true, true)] {
            XCTAssertTrue(LibraryPlan.fetches(picture, keep: .everything, expensive: expensive, constrained: constrained))
            XCTAssertFalse(LibraryPlan.fetches(model, keep: .everything, expensive: expensive, constrained: constrained), "a model's size is unknown")
            XCTAssertTrue(LibraryPlan.fetches(smallScan, keep: .everything, expensive: expensive, constrained: constrained))
            XCTAssertFalse(LibraryPlan.fetches(bigScan, keep: .everything, expensive: expensive, constrained: constrained))
        }
        // Never a kind the person chose not to keep.
        XCTAssertFalse(LibraryPlan.fetches(model, keep: .pictures, expensive: false, constrained: false))
        XCTAssertFalse(LibraryPlan.fetches(smallScan, keep: .models, expensive: false, constrained: false))
    }
}

private extension OnDeviceLibrary {
    func then(_ body: (OnDeviceLibrary) -> Void) -> OnDeviceLibrary { body(self); return self }
}
