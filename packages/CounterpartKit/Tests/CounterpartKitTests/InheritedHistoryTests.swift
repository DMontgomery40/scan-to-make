import XCTest
@testable import CounterpartKit

final class InheritedHistoryTests: XCTestCase {
    func testSnapshotComesBeforeThisProjectsOwnWordsAndSurvivesSourceDeletion() throws {
        let projects = try JSONDecoder().decode([Project].self, from: fixture("inherited-history.json"))
        let copy = projects[1]
        let conversation = ProjectConversation(project: copy, projects: projects)
        XCTAssertEqual(conversation.inheritedLine, "From “Forester phone mount”")
        XCTAssertEqual(conversation.inheritedFrom?.id, projects[0].id)
        XCTAssertEqual(conversation.inheritedFrom?.exists, true)
        XCTAssertEqual(conversation.inheritedEntries.map(\.text), ["A mount for my phone.", "Which case is on the phone?", "The case is a JETech clear case.", "Made a holder for that case."])
        XCTAssertEqual(conversation.inheritedEntries.map(\.atMs), [1794348000010, 1794348000020, 1794348000030, 1794348000040])
        XCTAssertEqual(conversation.inheritedEntries.map(\.role), [.person, .counterpart, .person, .counterpart])
        XCTAssertEqual(conversation.entries.map(\.text), ["Add a swivel."])
        let deleted = ProjectConversation(project: copy, projects: [copy])
        XCTAssertEqual(deleted.inheritedLine, "From “Forester phone mount”, since deleted")
        XCTAssertEqual(deleted.inheritedEntries, conversation.inheritedEntries)
        XCTAssertEqual(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(copy)).inherited, copy.inherited)
    }
}
