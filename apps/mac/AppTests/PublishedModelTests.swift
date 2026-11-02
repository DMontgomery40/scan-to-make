import XCTest
import CounterpartKit

/// PRD §8.11: print what the designer published; the Mac's part is the file, the choices and the credit.
final class PublishedModelTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testAPublishedProjectReadsItsCreditFilesAndAsk() throws {
        let json = #"""
        {"id":"p","credit":{"url":"https://makerworld.com/en/models/1","designer":"Kass 3D","site":"MakerWorld","title":"Caliper card","licence":"CC BY"},
         "files":{"original":["published/caliper.3mf"],"current":"current/model.3mf"},
         "ask":{"id":"a1","type":"choice","question":"Which plate?","options":[{"id":"p1","label":"150 mm","detail":"Plate 1"},{"id":"p2","label":"Depth gauge"}],"multiple":true,"status":"open"}}
        """#
        let extras = try JSONDecoder().decode(PublishedExtras.self, from: Data(json.utf8))
        XCTAssertEqual(extras.credit?.line, "by Kass 3D on MakerWorld")
        XCTAssertEqual(extras.current, "current/model.3mf")
        XCTAssertEqual(extras.choiceAsk?.options?.map(\.label), ["150 mm", "Depth gauge"])
        XCTAssertNil(extras.fileAsk)
        let answered = try JSONDecoder().decode(PublishedExtras.self, from: Data(#"{"ask":{"id":"a","type":"file","question":"q","status":"answered"}}"#.utf8))
        XCTAssertNil(answered.fileAsk, "an answered Ask asks nothing")
        let plain = try JSONDecoder().decode(PublishedExtras.self, from: Data(#"{"ask":{"id":"a","question":"Can you send a close-up?","answers":["camera"],"status":"open"}}"#.utf8))
        XCTAssertNil(plain.fileAsk); XCTAssertNil(plain.choiceAsk)
        XCTAssertEqual(PublishedExtras.Credit(url: "u", site: "Printables").line, "on Printables")
    }

    func testANewDownloadIsOfferedOnlyWhenItCanBeTheFile() throws {
        let ask = try JSONDecoder().decode(PublishedExtras.Ask.self, from: Data(#"""
        {"id":"a","type":"file","question":"Download it","accepts":["3mf","stl"],"askedAtMs":\#(now.timeIntervalSince1970 * 1000),"status":"open"}
        """#.utf8))
        func file(_ name: String, created: Double, modified: Double = -10, size: Int = 1000) -> DownloadsWatcher.DownloadedFile {
            .init(url: URL(fileURLWithPath: "/Users/x/Downloads/\(name)"), created: now.addingTimeInterval(created), modified: now.addingTimeInterval(modified), size: size)
        }
        let files = [file("Caliper.3mf", created: 30), file("Older.3mf", created: -3600), file("Photo.jpg", created: 40),
                     file("Half.3mf", created: 50, modified: -0.5), file("Empty.stl", created: 20, size: 0), file("Gauge.STL", created: 45)]
        XCTAssertEqual(DownloadsWatcher.matches(files, ask: ask, now: now).map(\.lastPathComponent), ["Gauge.STL", "Caliper.3mf"],
                       "newest first; never one from before the question, a photo, a download still being written, or an empty file")
    }

    func testAModelLinkIsFoundInWhatWasTyped() {
        let text = "Print this https://makerworld.com/en/models/12345 in black and yellow"
        XCTAssertEqual(ModelLink.find(in: text)?.host, "makerworld.com")
        XCTAssertEqual(ModelLink.words(in: text, without: ModelLink.find(in: text)!), "Print this  in black and yellow")
        XCTAssertNil(ModelLink.find(in: "A hook for my stroller handle"))
        XCTAssertNil(ModelLink.find(in: "A holder for this mic https://rode.com/en/microphones/on-camera/videomic-go-ii"),
                     "a product page is a reference for a fitted part, not a published model")
        XCTAssertEqual(ModelLink.find(in: "https://www.printables.com/model/123-hook and https://rode.com/x")?.host, "www.printables.com")
        XCTAssertNotNil(ModelLink.find(in: "use https://example.com/files/gauge.3mf"), "a direct 3MF link is a published file")
    }
}
