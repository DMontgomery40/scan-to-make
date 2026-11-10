import XCTest
import Foundation
@testable import HandheldKit

extension ThreeMFTests {
    func testPartNamesAreLiteralEvenWithUnzipPatternCharacters() throws {
        for (n, name) in ["3D/part[1]*?.model", "-part.model", "3D/back\\slash.model"].enumerated() {
            let url = try package("literal-\(n)", [name: model(box(1, "literal"), build: "<item objectid=\"1\"/>"),
                "_rels/.rels": "<Relationships><Relationship Target=\"/\(name)\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>"])
            XCTAssertEqual(try ThreeMF.read(url).meshes.first?.name, "literal")
        }
    }

    func testMissingOrMalformedReferencedPartDoesNotHideHealthyComponents() throws {
        let root = model("<object id=\"2\"><components><component objectid=\"1\" p:path=\"/3D/missing.model\"/><component objectid=\"1\" p:path=\"/3D/broken.model\"/><component objectid=\"1\"/></components></object>" + box(1, "kept"),
            build: "<item objectid=\"2\"/>", extra: "xmlns:p=\"urn:production\"")
        let url = try package("partial", ["3D/3dmodel.model": root, "3D/broken.model": "<model><resources>"])
        XCTAssertEqual(try ThreeMF.read(url).meshes.map(\.name), ["kept"])
    }

    func testAHealthyComponentIsKeptRegardlessOfBrokenSiblingOrder() throws {
        let root = model(box(1, "kept") + "<object id=\"2\"><components><component objectid=\"1\"/><component objectid=\"1\" p:path=\"/3D/broken.model\"/><component objectid=\"1\" p:path=\"/3D/broken.model\"/></components></object>",
            build: "<item objectid=\"2\"/>", extra: "xmlns:p=\"urn:production\"")
        XCTAssertEqual(try ThreeMF.read(package("partial-last", ["3D/3dmodel.model": root, "3D/broken.model": "<model>"])).meshes.map(\.name), ["kept"])
    }

    func testAllMissingComponentsRefuseWithTheMissingPartReason() throws {
        let root = model("<object id=\"2\"><components><component objectid=\"1\" p:path=\"/3D/missing.model\"/></components></object>", build: "<item objectid=\"2\"/>", extra: "xmlns:p=\"urn:production\"")
        XCTAssertThrowsError(try ThreeMF.read(package("all-missing", ["3D/3dmodel.model": root]))) {
            XCTAssertTrue(String(describing: $0).contains("missing.model"))
            XCTAssertTrue(String(describing: $0).contains("no supported mesh triangles"))
        }
    }

    func testUnsupportedGeometryCannotSilentlyDisappearBesideAHealthyObject() throws {
        let noTriangles = "<object id=\"2\"><mesh><vertices><vertex x=\"0\" y=\"0\" z=\"0\"/></vertices></mesh></object>"
        let url = try package("partial-unsupported", ["3D/3dmodel.model": model(box(1, "cube") + noTriangles, build: "<item objectid=\"1\"/><item objectid=\"2\"/>")])
        XCTAssertThrowsError(try ThreeMF.read(url)) { XCTAssertTrue(String(describing: $0).contains("triangles")) }
    }

    func testUndrawableGeometryReportsAReasonInsteadOfAnEmptySuccess() throws {
        let vertexOnly = "<object id=\"1\"><mesh><vertices><vertex x=\"0\" y=\"0\" z=\"0\"/></vertices></mesh></object>"
        let invalidIndices = box(1, "bad").replacingOccurrences(of: "v1=\"0\"", with: "v1=\"999\"").replacingOccurrences(of: "v1=\"4\"", with: "v1=\"999\"").replacingOccurrences(of: "v1=\"1\"", with: "v1=\"999\"").replacingOccurrences(of: "v1=\"2\"", with: "v1=\"999\"").replacingOccurrences(of: "v1=\"3\"", with: "v1=\"999\"")
        for (n, geometry) in [vertexOnly, invalidIndices].enumerated() {
            let url = try package("unsupported-\(n)", ["3D/3dmodel.model": model(geometry, build: "<item objectid=\"1\"/>")])
            XCTAssertThrowsError(try ThreeMF.read(url)) { XCTAssertTrue(String(describing: $0).contains("triangles")) }
        }
        for (n, xml) in [model(box(1, "cube"), build: "<item objectid=\"1\" transform=\"bad\"/>"), model(box(1, "cube"), build: "<item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 nan 0 0\"/>"), model(box(1, "cube"), build: "<item objectid=\"1\"/>", unit: "furlong")].enumerated() {
            XCTAssertThrowsError(try ThreeMF.read(package("invalid-placement-\(n)", ["3D/3dmodel.model": xml])))
        }
    }

}
