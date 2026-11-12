import XCTest
@testable import CounterpartKit

final class AskSizesFormTests: XCTestCase {
    private func ask(kind: String? = "sizes", _ sizes: [Project.Ask.Size]?) -> Project.Ask {
        Project.Ask(id: "a", question: "Can you confirm or correct these?", answers: ["sizes", "text", "camera"], kind: kind, sizes: sizes)
    }
    private let waisted: [Project.Ask.Size] = [
        .init(id: "size-1", label: "width at the pink stripe", mm: 64, from: "scan"),
        .init(id: "size-2", label: "width at the waist", mm: 53.5, from: "scan"),
        .init(id: "size-3", label: "height to the cap tip", mm: 107, from: "published"),
    ]

    func testTheFieldsArePrefilledWithTheMacsNumbersAndConfirmSendsThemAll() throws {
        let form = try XCTUnwrap(AskSizesForm(ask(waisted)))
        XCTAssertEqual(form.fields.map(\.text), ["64", "53.5", "107"])
        XCTAssertEqual(form.fields.map(\.label), waisted.map(\.label), "the Mac's labels, whatever the ids are")
        XCTAssertTrue(form.unchanged)
        XCTAssertEqual(form.answer, [.init(id: "size-1", mm: 64), .init(id: "size-2", mm: 53.5), .init(id: "size-3", mm: 107)])
    }

    /// The Mac's number can be finer than the field shows (68.412 shown as 68.41). Untouched, that is still Confirm,
    /// and the Mac keeps its own number for it (`answeredSizes`), never the rounded echo sent here.
    func testANumberFinerThanTheFieldShowsIsStillUnchanged() throws {
        var form = try XCTUnwrap(AskSizesForm(ask([.init(id: "a", label: "width", mm: 68.412, from: "scan"),
                                                   .init(id: "b", label: "waist", mm: 53.4567, from: "scan")])))
        XCTAssertEqual(form.fields.map(\.text), ["68.41", "53.46"])
        XCTAssertTrue(form.unchanged)
        XCTAssertEqual(form.answer, [.init(id: "a", mm: 68.41), .init(id: "b", mm: 53.46)])
        form.fields[0].text = "68.42"
        XCTAssertFalse(form.unchanged)
        XCTAssertEqual(form.answer, [.init(id: "a", mm: 68.42, measured: true), .init(id: "b", mm: 53.46)])
    }

    func testACorrectionAComma_AndABlankField() throws {
        var form = try XCTUnwrap(AskSizesForm(ask(waisted)))
        form.fields[0].text = " 63 "
        form.fields[1].text = "53,2"
        XCTAssertFalse(form.unchanged)
        XCTAssertEqual(form.answer, [.init(id: "size-1", mm: 63, measured: true), .init(id: "size-2", mm: 53.2, measured: true), .init(id: "size-3", mm: 107)])
        // A size the person doesn't know is left out, never sent as accepted.
        form.fields[2].text = ""
        XCTAssertEqual(form.answer?.map(\.id), ["size-1", "size-2"])
    }

    func testNothingIsSentWhileAFieldIsNotANumberOrAllAreBlank() throws {
        var form = try XCTUnwrap(AskSizesForm(ask(waisted)))
        for bad in ["about 60", "0", "-4", "10001", "6 3"] {
            form.fields[0].text = bad
            XCTAssertNil(form.answer, bad)
        }
        for index in form.fields.indices { form.fields[index].text = " " }
        XCTAssertNil(form.answer)
    }

    /// Train #499 review, F3: words or a caliper photo sent from the size card dropped the numbers. One answer
    /// carries everything the card holds.
    func testAnotherAnswerFromTheCardCarriesTheNumbersAsTheyStand() throws {
        var form = try XCTUnwrap(AskSizesForm(ask(waisted)))
        XCTAssertEqual(form.carried, .sizes([.init(id: "size-1", mm: 64), .init(id: "size-2", mm: 53.5), .init(id: "size-3", mm: 107)]), "prefilled")
        form.fields[0].text = "63"; form.fields[2].text = ""
        XCTAssertEqual(form.carried, .sizes([.init(id: "size-1", mm: 63, measured: true), .init(id: "size-2", mm: 53.5)]), "edited, one unknown: the typed one carries as measured")
        form.fields[1].text = "about 53"
        XCTAssertEqual(form.carried, .invalid, "nothing goes until the field is a number or empty")
        for index in form.fields.indices { form.fields[index].text = " " }
        XCTAssertEqual(form.carried, AskSizesForm.Carried.none, "every size unknown: the other answer goes alone")
    }

    /// The same forms on every client (train #499 review, F8): Swift's `Double` alone took "1e3", ".5" and "5.".
    func testANumberIsDigitsWithAtMostOneDecimalPart() {
        for good in ["64", "53.5", " 53,25 ", "0.5", "10000"] { XCTAssertNotNil(AskSizesForm.millimetres(good), good) }
        for bad in ["1e3", ".5", "5.", "5.5.5", "+5", "-4", "0", "10001", "6 3", "about 60", "", "٥"] { XCTAssertNil(AskSizesForm.millimetres(bad), bad) }
    }

    func testOnlyASizesQuestionWithSizesIsOne() {
        XCTAssertNil(AskSizesForm(ask(kind: "closeup", waisted)))
        XCTAssertNil(AskSizesForm(ask(nil)))
        XCTAssertNil(AskSizesForm(ask([])))
        XCTAssertEqual(AskSizesForm(ask([.init(id: "only", label: "inner diameter", mm: 25, from: "published")]))?.fields.count, 1, "one size is a size question too")
    }

    func testTheAnswerBodyCarriesNumbersWithWordsAndPhotos() throws {
        let body = CompanionClient.answerBody(bestGuess: false, text: "The waist is under the label.", photoNames: ["caliper.jpg"],
                                              sizes: [.init(id: "size-1", mm: 63, measured: true), .init(id: "size-2", mm: 107)])
        let sent = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: body))
        // #622: which numbers were typed goes beside the numbers, so a Mac from before it still takes the answer.
        XCTAssertEqual(sent, .object(["text": .string("The waist is under the label."), "photoNames": .array([.string("caliper.jpg")]),
                                      "sizes": .array([.object(["id": .string("size-1"), "mm": .number(63)]), .object(["id": .string("size-2"), "mm": .number(107)])]),
                                      "measured": .array([.string("size-1")])]))
        XCTAssertNil(CompanionClient.answerBody(bestGuess: true, text: nil, photoNames: [], sizes: [])["sizes"], "no sizes key for other questions")
    }

    func testAnAskFromTheMacDecodesItsKindAndSizes() throws {
        let json = #"{"id":"a","question":"Q?","answers":["sizes","text","camera"],"status":"open","kind":"sizes","sizes":[{"id":"size-1","label":"width at the waist","mm":53,"from":"scan"}]}"#
        let ask = try JSONDecoder().decode(Project.Ask.self, from: Data(json.utf8))
        XCTAssertEqual(ask.kind, "sizes")
        XCTAssertEqual(ask.sizes, [.init(id: "size-1", label: "width at the waist", mm: 53, from: "scan")])
        XCTAssertNil(ask.type)
        XCTAssertNil(ask.sizes?.first?.product, "a question saved before Nov 12 names no product")
    }

    /// #622: the Forester phone mount (`size-sources.json`, which the companion, Android and Linux read too). Each
    /// field says where the Mac's number came from, a published one with its product and where it was published;
    /// an untouched number goes as accepted and only a typed one as measured.
    func testEachSizeKeepsItsSourceAndOnlyATypedNumberIsMeasured() throws {
        struct Fixture: Decodable {
            struct Words: Decodable { var from: String; var product: String?; var reference: String?; var apple: String }
            struct Sent: Decodable { var id: String; var mm: Double }
            struct Case: Decodable { var name: String; var edits: [String: String]; var sizes: [Sent]; var measured: [String]; var unchanged: Bool }
            var ask: Project.Ask; var words: [Words]; var answers: [Case]
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../contracts/fixtures/size-sources.json").standardizedFileURL
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.ask.sizes?.first?.product, "JETech clear case for iPhone 16 Pro")
        for row in fixture.words { XCTAssertEqual(AskSizesForm.source(row.from, product: row.product, reference: row.reference), row.apple, row.from) }
        let form = try XCTUnwrap(AskSizesForm(fixture.ask))
        XCTAssertEqual(form.fields.map(AskSizesForm.source), [
            "Published for JETech clear case for iPhone 16 Pro · example.invalid", "Published for JETech clear case for iPhone 16 Pro · JETech product listing (placeholder)",
            "The Mac's estimate, not measured", "Read from your scan", "Published size, product not named"])
        for answer in fixture.answers {
            var edited = form
            for (id, text) in answer.edits { edited.fields[try XCTUnwrap(edited.fields.firstIndex { $0.id == id })].text = text }
            let sent = try XCTUnwrap(edited.answer, answer.name)
            XCTAssertEqual(sent.map(\.id), answer.sizes.map(\.id), answer.name)
            XCTAssertEqual(sent.map(\.mm), answer.sizes.map(\.mm), answer.name)
            XCTAssertEqual(sent.filter(\.measured).map(\.id), answer.measured, answer.name)
            XCTAssertEqual(edited.unchanged, answer.unchanged, answer.name)
            XCTAssertEqual(edited.carried, .sizes(sent), "words or a photo from the card carry the same marks: \(answer.name)")
            let body = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: CompanionClient.answerBody(bestGuess: false, text: nil, photoNames: [], sizes: sent)))
            XCTAssertEqual(body.object?["measured"], .array(answer.measured.map(JSONValue.string)), answer.name)
        }
    }
}
