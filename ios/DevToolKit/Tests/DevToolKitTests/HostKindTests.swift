import Foundation
import Testing
@testable import DevToolKit

/// Desktop or DevTool server, from message 2's `app` (SPEC.md §4.3).
@Suite struct HostKindTests {
    @Test(arguments: [
        ("devtool/0.3.2", HostKind.desktop),
        ("devtool-server/0.3.2", .server),
        ("devtool-server", .server),
        ("devtool-server/", .server),
        ("devtool-serverx/1", .desktop),
        ("devtool-server-beta/1", .desktop),
        ("devtool", .desktop),
        ("", .desktop),
        ("fake/1", .desktop),
        ("DevTool-Server/1", .desktop),
    ])
    func appNamesTheHost(app: String, kind: HostKind) {
        #expect(HostKind(app: app) == kind)
    }

    @Test func helloCarriesTheKind() throws {
        let server = try DesktopHello.parse(Data(#"{"v":3,"min":2,"app":"devtool-server/0.3.2","features":[],"desktopName":"build-box","result":"ok"}"#.utf8))
        #expect(server.hostKind == .server)
        let desktop = try DesktopHello.parse(Data(#"{"v":3,"min":2,"app":"devtool/0.3.2","features":[],"desktopName":"mbp","result":"ok"}"#.utf8))
        #expect(desktop.hostKind == .desktop)
    }

    @Test func recordsFromBeforeServersAreDesktops() throws {
        let old = #"{"id":"a","name":"n","relayURL":"wss://r","desktopX25519PublicKey":"x","desktopEd25519PublicKey":"e","keysReference":"k","pairedAt":0,"features":["pin"]}"#
        let record = try JSONDecoder().decode(DesktopRecord.self, from: Data(old.utf8))
        #expect(record.hostKind == nil)
        #expect(!record.isServer)

        var server = record
        server.hostKind = .server
        let decoded = try JSONDecoder().decode(DesktopRecord.self, from: try JSONEncoder().encode(server))
        #expect(decoded.hostKind == .server)
        #expect(decoded.isServer)
        #expect(decoded == server)
    }

    @Test func unknownStoredKindIsADesktop() throws {
        let newer = #"{"id":"a","name":"n","relayURL":"wss://r","desktopX25519PublicKey":"x","desktopEd25519PublicKey":"e","keysReference":"k","pairedAt":0,"hostKind":"toaster"}"#
        let record = try JSONDecoder().decode(DesktopRecord.self, from: Data(newer.utf8))
        #expect(record.hostKind == .desktop)
        #expect(!record.isServer)
    }
}

/// `RelayDesktopConnection` reports the kind with each session, before `.online`.
@Suite(.serialized) struct HostKindConnectionTests {
    static func isHostKind(_ event: DesktopConnectionEvent) -> Bool {
        if case .hostKind = event { return true }
        return false
    }

    @Test func serverHelloReportsAServer() async throws {
        let rig = RelayConnectionTests.Rig()
        let server = await rig.desktop("build-box")
        server.helloApp = "devtool-server/0.3.2"
        server.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: server))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor(RelayConnectionTests.isInbox)

        let recorded = await events.events
        let kind = try #require(recorded.firstIndex(where: Self.isHostKind))
        let online = try #require(recorded.firstIndex(of: .state(.online)))
        #expect(recorded[kind] == .hostKind(.server))
        #expect(kind < online)
        await connection.stop()
    }

    @Test func desktopHelloReportsADesktop() async throws {
        let o = try await ChatConnectionTests.online()
        let recorded = await o.events.events
        #expect(recorded.filter(Self.isHostKind) == [.hostKind(.desktop)])
        await o.connection.stop()
    }

    /// The app saves the record on `.pairing(.accepted)`, so the kind has to
    /// come after it.
    @Test func pairingWithAServerReportsItAfterAccepted() async throws {
        let rig = RelayConnectionTests.Rig()
        let server = await rig.desktop("build-box")
        server.helloApp = "devtool-server"
        server.offer()
        let connection = rig.factory.pairingConnection(for: server.invite, deviceName: "Test iPhone")
        let events = EventRecorder(connection)
        await connection.start()

        var i = try await events.waitFor { $0 == .pairing(.accepted(desktopName: "build-box")) }
        i = try await events.waitFor(after: i) { $0 == .hostKind(.server) }
        try await events.waitFor(after: i, RelayConnectionTests.isState(.online))
        await connection.stop()
    }
}

/// The mock tells the app what its record says it is.
@Suite struct MockHostKindTests {
    @Test func mockReportsItsKind() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), hostKind: .server)
        let events = EventRecorder(mock)
        await mock.start()
        let i = try await events.waitFor { $0 == .hostKind(.server) }
        try await events.waitFor(after: i, RelayConnectionTests.isState(.online))
        await mock.stop()
    }

    @Test func factoryUsesTheRecordsKind() async throws {
        var record = DesktopRecord(
            id: "d", name: "desk", relayURL: URL(string: "wss://r")!,
            desktopX25519PublicKey: "x", desktopEd25519PublicKey: "e", keysReference: "k"
        )
        record.hostKind = .server
        let connection = MockDesktopConnectionFactory().connection(for: record)
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .hostKind(.server) }
        await connection.stop()
    }
}
