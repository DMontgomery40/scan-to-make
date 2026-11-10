import XCTest
import Foundation
@testable import HandheldKit

extension ThreeMFTests {
    private func refused(_ url: URL, _ limits: ThreeMFLimits, containing reason: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try ThreeMF.read(url, limits: limits), file: file, line: line) {
            XCTAssertTrue(String(describing: $0).contains(reason), "\($0)", file: file, line: line)
        }
    }

    func testZipPartBytesAreRefusedFromTheListingBeforeParsing() throws {
        let url = try package("part-bytes", ["3D/3dmodel.model": String(repeating: "x", count: 2048)])
        var limits = ThreeMFLimits(); limits.partBytes = 1024
        refused(url, limits, containing: "part bytes")
    }

    func testZipTotalBytesIncludePartsBeforeAnyAreInflated() throws {
        let xml = model(box(1, "cube"), build: "<item objectid=\"1\"/>")
        let url = try package("total-bytes", ["3D/3dmodel.model": xml, "3D/unplaced.model": xml])
        var limits = ThreeMFLimits(); limits.totalBytes = xml.utf8.count + 512
        refused(url, limits, containing: "total bytes")
    }

    func testZipListingAndEntryCountsAreBounded() throws {
        let url = try package("entries", ["3D/3dmodel.model": model(box(1, "cube"), build: "<item objectid=\"1\"/>")])
        var limits = ThreeMFLimits(); limits.listingBytes = 32
        refused(url, limits, containing: "listing bytes")
        limits = ThreeMFLimits(); limits.archiveEntries = 1
        refused(url, limits, containing: "archive entries")
    }

    func testVerticesAndTrianglesAreCountedAcrossModelPartsDuringParsing() throws {
        let root = model(box(1, "root") + "<object id=\"2\"><components><component objectid=\"1\" p:path=\"/3D/child.model\"/></components></object>",
            build: "<item objectid=\"1\"/><item objectid=\"2\"/>", extra: "xmlns:p=\"urn:production\"")
        let url = try package("parsed", ["3D/3dmodel.model": root, "3D/child.model": model(box(1, "child"), build: "")])
        var limits = ThreeMFLimits(); limits.vertices = 15
        refused(url, limits, containing: "parsed vertices")
        limits = ThreeMFLimits(); limits.triangles = 23
        refused(url, limits, containing: "parsed triangles")
    }

    func testComponentExpansionBoundsMeshesVerticesAndRenderCorners() throws {
        let url = try package("placements", ["3D/3dmodel.model": model(box(1, "cube"), build: "<item objectid=\"1\"/><item objectid=\"1\"/>")])
        var limits = ThreeMFLimits(); limits.placedMeshes = 1
        refused(url, limits, containing: "placed meshes")
        limits = ThreeMFLimits(); limits.placedVertices = 15
        refused(url, limits, containing: "placed vertices")
        limits = ThreeMFLimits(); limits.renderedVertices = 71
        refused(url, limits, containing: "rendered vertices")
    }

    func testComponentDepthAndEmptyBranchExpansionAreBounded() throws {
        let assembly = "<object id=\"2\"><components><component objectid=\"1\"/><component objectid=\"1\"/></components></object><object id=\"3\"><components><component objectid=\"2\"/><component objectid=\"2\"/></components></object>"
        let url = try package("depth", ["3D/3dmodel.model": model(box(1, "cube") + assembly, build: "<item objectid=\"3\"/>")])
        var limits = ThreeMFLimits(); limits.depth = 2
        refused(url, limits, containing: "component depth")
        let empty = try package("empty-branches", ["3D/3dmodel.model": model("<object id=\"1\"/>" + assembly, build: "<item objectid=\"3\"/>")])
        limits = ThreeMFLimits(); limits.placements = 3
        refused(empty, limits, containing: "component placements")
    }

    func testColourTablesAndXMLDepthHaveBounds() throws {
        let url = try package("colours", ["3D/3dmodel.model": model("<basematerials id=\"7\"><base displaycolor=\"#FF0000\"/><base displaycolor=\"#00FF00\"/></basematerials>" + box(1, "cube"), build: "<item objectid=\"1\"/>")])
        var limits = ThreeMFLimits(); limits.colours = 1
        refused(url, limits, containing: "colours")
        limits = ThreeMFLimits(); limits.xmlDepth = 3
        refused(url, limits, containing: "XML depth")
    }

    func testDeclaredZipSizeCannotBypassTheInflationBound() throws {
        let url = try package("false-size", ["3D/3dmodel.model": model(box(1, "cube"), build: "<item objectid=\"1\"/>")])
        var data = try Data(contentsOf: url)
        let signature = Data([0x50, 0x4b, 0x01, 0x02])
        var cursor = 0
        while let range = data.range(of: signature, in: cursor..<data.count) {
            let start = range.lowerBound
            let length = Int(data[start + 28]) + Int(data[start + 29]) * 256
            let name = String(decoding: data[(start + 46)..<(start + 46 + length)], as: UTF8.self)
            if name == "3D/3dmodel.model" {
                data.replaceSubrange((start + 24)..<(start + 28), with: [16, 0, 0, 0]); break
            }
            cursor = start + 46 + length
        }
        try data.write(to: url)
        refused(url, ThreeMFLimits(), containing: "inflated bytes")
    }

    func testGeometryAtTheExactBudgetStillDraws() throws {
        let url = try package("exact", ["3D/3dmodel.model": model(box(1, "cube"), build: "<item objectid=\"1\"/>")])
        var limits = ThreeMFLimits()
        limits.vertices = 8; limits.triangles = 12; limits.placedMeshes = 1; limits.placedVertices = 8
        limits.renderedVertices = 36; limits.depth = 1; limits.placements = 1; limits.colours = 0; limits.xmlDepth = 6
        limits.materials = 1
        let read = try ThreeMF.read(url, limits: limits)
        XCTAssertEqual(read.meshes.count, 1)
        XCTAssertEqual(try threeMFNode(read, tint: nil, limits: limits).childNodes.count, 1)
    }

    func testSceneKitRechecksTheExpansionBudgetBeforeAllocatingBuffers() throws {
        let url = try package("scene-bounds", ["3D/3dmodel.model": model(box(1, "cube"), build: "<item objectid=\"1\"/><item objectid=\"1\"/>")])
        let read = try ThreeMF.read(url)
        var limits = ThreeMFLimits(); limits.renderedVertices = 71
        XCTAssertThrowsError(try threeMFNode(read, tint: nil, limits: limits)) { XCTAssertTrue(String(describing: $0).contains("rendered vertices")) }
        limits = ThreeMFLimits(); limits.materials = 1
        XCTAssertThrowsError(try threeMFNode(read, tint: nil, limits: limits)) { XCTAssertTrue(String(describing: $0).contains("rendered materials")) }
    }

    func testDTDEntitiesAreRefusedBeforeExpansion() throws {
        let xml = model(box(1, "cube"), build: "<item objectid=\"1\"/>").replacingOccurrences(of: "<model ", with: "<!DOCTYPE model [<!ENTITY a 'expanded'>]><model ")
        let url = try package("entity", ["3D/3dmodel.model": xml])
        XCTAssertThrowsError(try ThreeMF.read(url))
    }

}
