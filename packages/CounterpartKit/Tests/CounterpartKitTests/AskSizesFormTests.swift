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
    }

    func testACorrectionAComma_AndABlankField() throws {
        var form = try XCTUnwrap(AskSizesForm(ask(waisted)))
        form.fields[0].text = " 63 "
        form.fields[1].text = "53,2"
        XCTAssertFalse(form.unchanged)
        XCTAssertEqual(form.answer, [.init(id: "size-1", mm: 63), .init(id: "size-2", mm: 53.2), .init(id: "size-3", mm: 107)])
        // A size the person doesn't know is left out, never sent as confirmed.
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
        XCTAssertEqual(form.carried, .sizes([.init(id: "size-1", mm: 63), .init(id: "size-2", mm: 53.5)]), "edited, one unknown")
        form.fields[1].text = "about 53"
        XCTAssertEqual(form.carried, .invalid, "nothing goes until the field is a number or empty")
        for index in form.fields.indices { form.fields[index].text = " " }
        XCTAssertEqual(form.carried, AskSizesForm.Carried.none, "every size unknown: the other answer goes alone")
    }

    func testOnlyASizesQuestionWithSizesIsOne() {
        XCTAssertNil(AskSizesForm(ask(kind: "closeup", waisted)))
        XCTAssertNil(AskSizesForm(ask(nil)))
        XCTAssertNil(AskSizesForm(ask([])))
        XCTAssertEqual(AskSizesForm(ask([.init(id: "only", label: "inner diameter", mm: 25, from: "published")]))?.fields.count, 1, "one size is a size question too")
    }

    func testTheAnswerBodyCarriesNumbersWithWordsAndPhotos() throws {
        let body = CompanionClient.answerBody(bestGuess: false, text: "The waist is under the label.", photoNames: ["caliper.jpg"], sizes: [.init(id: "size-1", mm: 63)])
        let sent = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: body))
        XCTAssertEqual(sent, .object(["text": .string("The waist is under the label."), "photoNames": .array([.string("caliper.jpg")]),
                                      "sizes": .array([.object(["id": .string("size-1"), "mm": .number(63)])])]))
        XCTAssertNil(CompanionClient.answerBody(bestGuess: true, text: nil, photoNames: [], sizes: [])["sizes"], "no sizes key for other questions")
    }

    func testAnAskFromTheMacDecodesItsKindAndSizes() throws {
        let json = #"{"id":"a","question":"Q?","answers":["sizes","text","camera"],"status":"open","kind":"sizes","sizes":[{"id":"size-1","label":"width at the waist","mm":53,"from":"scan"}]}"#
        let ask = try JSONDecoder().decode(Project.Ask.self, from: Data(json.utf8))
        XCTAssertEqual(ask.kind, "sizes")
        XCTAssertEqual(ask.sizes, [.init(id: "size-1", label: "width at the waist", mm: 53, from: "scan")])
        XCTAssertNil(ask.type)
        XCTAssertEqual(AskSizesForm.source("published"), "from the maker")
        XCTAssertEqual(AskSizesForm.source("scan"), "from your scan")
    }
}
