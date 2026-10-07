import Foundation
import Testing
@testable import DevToolKit

/// `protocol/vectors/project-tile.json` (§10).
@Suite struct ProjectTileVectorTests {
    private func number(_ value: JSONValue?) -> Double? {
        if case .number(let n)? = value { return n }
        return nil
    }

    private func color(_ value: JSONValue?) -> UInt32? {
        guard let s = value?.stringValue, s.hasPrefix("#") else { return nil }
        return UInt32(s.dropFirst(), radix: 16)
    }

    @Test func palette() throws {
        let palette = try Vectors.load("project-tile.json")["palette"].array
        #expect(palette.count == ProjectTile.palette.count)
        for (swatch, expected) in zip(ProjectTile.palette, palette) {
            #expect(swatch.name == expected["name"].str)
            #expect(swatch.lightBg == color(expected["light"]["bg"]))
            #expect(swatch.lightFg == color(expected["light"]["fg"]))
            #expect(swatch.darkBg == color(expected["dark"]["bg"]))
            #expect(swatch.darkFg == color(expected["dark"]["fg"]))
        }
    }

    @Test func tiles() throws {
        let tiles = try Vectors.load("project-tile.json")["tiles"].array
        #expect(tiles.count >= 10)
        for sample in tiles {
            let id = sample["id"].str, name = sample["name"].str
            let tile = ProjectTile(id: id, name: name, emoji: sample["emoji"]?.stringValue)
            #expect(Double(ProjectTile.fnv1a32(id)) == number(sample["fnv1a32"]), "\(id)")
            #expect(tile.text == sample["text"].str, "\(name)")
            #expect(Double(tile.hue) == number(sample["hue"]), "\(id)")
            #expect(tile.emoji == sample["emoji"]?.stringValue, "\(name)")
        }
    }

    @Test func places() throws {
        let places = try Vectors.load("project-tile.json")["places"].array
        #expect(!places.isEmpty)
        for sample in places {
            let stream = sample["stream"]
            let isMain: Bool
            if case .bool(let b)? = stream["isMain"] { isMain = b } else { isMain = false }
            let place = ProjectTile.place(project: sample["project"].str, stream: stream["name"]?.stringValue, isMain: isMain)
            #expect(place == sample["place"].str)
        }
    }

    @Test func inboxProjectHelpers() {
        let main = InboxStream(id: "m", name: "main", isMain: true)
        let release = InboxStream(id: "r", name: "0.6.0")
        let project = InboxProject(id: "p-claude", name: "claude-project", streams: [main, release], tasks: [])
        #expect(project.tile.text == "CP")
        #expect(project.place(of: main) == "claude-project")
        #expect(project.place(of: release) == "claude-project › 0.6.0")
    }
}
