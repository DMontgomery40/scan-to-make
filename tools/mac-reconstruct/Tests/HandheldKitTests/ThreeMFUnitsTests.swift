import XCTest
import Foundation
@testable import HandheldKit

extension ThreeMFTests {
    func testSamePartCentimetreCubesKeepTheirBuildSpacing() throws {
        let url = try package("centimetres", ["3D/3dmodel.model": model(box(1, "cube", size: 1),
            build: "<item objectid=\"1\"/><item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 2 0 0\"/>", unit: "centimeter")])
        let read = try ThreeMF.read(url)
        XCTAssertEqual(read.meshes.count, 2)
        XCTAssertEqual(read.meshes[0].positions.map(\.x).min(), 0)
        XCTAssertEqual(read.meshes[0].positions.map(\.x).max(), 10)
        XCTAssertEqual(read.meshes[1].positions.map(\.x).min(), 20)
        XCTAssertEqual(read.meshes[1].positions.map(\.x).max(), 30)
    }

    func testComponentTranslationsUseTheirOwningPartsUnitsAtEveryBoundary() throws {
        let child = model("<object id=\"2\"><components><component objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 2 0 0\"/></components></object>" + box(1, "inch", size: 1), build: "", unit: "inch")
        let root = model("<object id=\"3\"><components><component objectid=\"2\" p:path=\"/3D/child.model\" transform=\"1 0 0 0 1 0 0 0 1 3 0 0\"/></components></object>",
            build: "<item objectid=\"3\" transform=\"1 0 0 0 1 0 0 0 1 4 0 0\"/>", unit: "centimeter", extra: "xmlns:p=\"urn:production\"")
        let read = try ThreeMF.read(package("units", ["3D/3dmodel.model": root, "3D/child.model": child]))
        XCTAssertEqual(read.meshes[0].positions.map(\.x).min()!, 120.8, accuracy: 0.001)
        XCTAssertEqual(read.meshes[0].positions.map(\.x).max()!, 146.2, accuracy: 0.001)
    }

}
