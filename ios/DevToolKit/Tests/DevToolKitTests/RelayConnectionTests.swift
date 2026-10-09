import Foundation
import Testing
@testable import DevToolKit

/// `RelayDesktopConnection` + `RelayClient` against the in-process `FakeRelay`.
@Suite(.serialized) struct RelayConnectionTests {
    static let timing = RelayTiming(
        pingInterval: .seconds(30), initialBackoff: .milliseconds(20),
        maxBackoff: .milliseconds(200), handshakeTimeout: .milliseconds(500)
    )

    struct Rig {
        let relay = FakeRelay()
        let phone = DeviceIdentity.generate()
        let factory: RelayDesktopConnectionFactory

        init() {
            factory = RelayDesktopConnectionFactory(
                identity: phone, deviceName: "Test iPhone", appVersion: "ios/0.1.0",
                connector: relay, timing: RelayConnectionTests.timing
            )
        }

        func desktop(_ name: String = "desk") async -> FakeRelay.Desktop {
            let desktop = FakeRelay.Desktop(name: name)
            await relay.add(desktop)
            return desktop
        }

        func record(for desktop: FakeRelay.Desktop) -> DesktopRecord {
            DesktopRecord(invite: desktop.invite, keysReference: "test")
        }
    }

    static func isState(_ state: ConnectionState) -> @Sendable (DesktopConnectionEvent) -> Bool {
        { $0 == .state(state) }
    }

    static let isInbox: @Sendable (DesktopConnectionEvent) -> Bool = {
        if case .inbox = $0 { return true }
        return false
    }

    @Test func pairThenResumeAfterReconnect() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.offer()
        let connection = rig.factory.pairingConnection(for: desktop.invite, deviceName: "Test iPhone")
        let events = EventRecorder(connection)
        await connection.start()

        var i = try await events.waitFor { $0 == .pairing(.pending) }
        i = try await events.waitFor(after: i) { $0 == .pairing(.accepted(desktopName: "desk")) }
        i = try await events.waitFor(after: i, Self.isState(.online))
        i = try await events.waitFor(after: i, Self.isInbox)
        #expect(desktop.pairings[rig.phone.deviceId] == rig.phone.x25519.pub)

        // The hello carried the pair token for this desktop.
        let hellos = await rig.relay.hellos
        guard case .hello(_, _, _, let pair)? = hellos.first else { Issue.record("no hello"); return }
        #expect(pair == RelayPair(to: desktop.id, token: desktop.invite.relayToken.base64URLEncodedString))

        // Events are delivered in order and refresh round-trips.
        await rig.relay.pushInbox(desktop)
        i = try await events.waitFor(after: i, Self.isInbox)
        try await connection.refresh()
        i = try await events.waitFor(after: i, Self.isInbox)

        // A relay restart: reconnect, handshake again with `resume`, no pair token.
        let handshakesBefore = desktop.handshakes
        await rig.relay.dropAll()
        i = try await events.waitFor(after: i, Self.isState(.connecting))
        i = try await events.waitFor(after: i, Self.isState(.online))
        try await events.waitFor(after: i, Self.isInbox)
        #expect(desktop.handshakes == handshakesBefore + 1)
        let lastHello = await rig.relay.hellos.last
        guard case .hello(_, _, _, let pairAfter)? = lastHello else { Issue.record("no hello"); return }
        #expect(pairAfter == nil)

        await connection.stop()
    }

    @Test func pendingUntilAcceptedOnDesktop() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.autoAccept = false
        desktop.offer()
        let connection = rig.factory.pairingConnection(for: desktop.invite, deviceName: "Test iPhone")
        let events = EventRecorder(connection)
        await connection.start()
        let i = try await events.waitFor(Self.isState(.awaitingApproval))
        await #expect(throws: DesktopConnectionError.notConnected) { try await connection.refresh() }
        // A pending session gets no inbox, even if the desktop pushes one.
        await rig.relay.pushInbox(desktop)
        for frame in desktop.accept(rig.phone.deviceId) {
            await rig.relay.send(from: desktop.id, to: rig.phone.deviceId, frame)
        }
        try await events.waitFor(after: i) { $0 == .pairing(.accepted(desktopName: "desk")) }
        try await events.waitFor(after: i, Self.isInbox)
        await connection.stop()
    }

    @Test func wrongProofIsRejected() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        // No live offer on the desktop: the proof can't match.
        let connection = rig.factory.pairingConnection(for: desktop.invite, deviceName: "Test iPhone")
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor { $0 == .pairing(.rejected) }
        try await events.waitFor(Self.isState(.revoked))
        await connection.stop()
    }

    @Test func pairingWindowLapseEndsThePairing() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.autoAccept = false
        desktop.offer()
        let connection = rig.factory.pairingConnection(for: desktop.invite, deviceName: "Test iPhone")
        let events = EventRecorder(connection)
        await connection.start()
        let i = try await events.waitFor(Self.isState(.awaitingApproval))
        await rig.relay.lapsePairing(desktop, phone: rig.phone.deviceId)
        try await events.waitFor(after: i) { $0 == .state(.failed("pairing window expired")) }
        // Nothing left to connect for: no reconnect that re-sends the spent token.
        let hellos = await rig.relay.hellos.count
        try await Task.sleep(for: .milliseconds(300))
        #expect(await rig.relay.hellos.count == hellos)
        await connection.stop()
    }

    @Test func unknownRelayValuesDontBreakASession() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        var i = try await events.waitFor(Self.isState(.online))
        i = try await events.waitFor(after: i, Self.isInbox)
        await rig.relay.pushRaw(#"{"t":"peer","id":"\#(desktop.id)","state":"hibernating"}"#, to: rig.phone.deviceId)
        await rig.relay.pushRaw(#"{"t":"error","code":"maintenance","to":"\#(desktop.id)"}"#, to: rig.phone.deviceId)
        await rig.relay.pushInbox(desktop)
        try await events.waitFor(after: i, Self.isInbox)
        #expect(await !events.events[i...].contains { if case .state = $0 { true } else { false } })
        await connection.stop()
    }

    @Test func twoDesktopsShareOneSocket() async throws {
        let rig = Rig()
        let a = await rig.desktop("a"), b = await rig.desktop("b")
        a.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        b.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let ca = rig.factory.connection(for: rig.record(for: a))
        let cb = rig.factory.connection(for: rig.record(for: b))
        let ea = EventRecorder(ca), eb = EventRecorder(cb)
        await ca.start()
        await cb.start()
        try await ea.waitFor(Self.isInbox)
        try await eb.waitFor(Self.isInbox)
        #expect(await rig.relay.openPhoneSockets == 1)
        #expect(await rig.relay.connectionCount == 1)

        // Frames are routed by desktop: an event from `a` reaches only `a`.
        let before = await eb.count
        await rig.relay.pushInbox(a)
        try await ea.waitFor(after: 2, Self.isInbox)
        try await Task.sleep(for: .milliseconds(50))
        #expect(await eb.count == before)

        // Stopping one keeps the socket for the other.
        await ca.stop()
        try await Task.sleep(for: .milliseconds(50))
        #expect(await rig.relay.openPhoneSockets == 1)
        try await cb.refresh()
        await cb.stop()
    }

    @Test func pairingWhileConnectedReauthenticatesWithToken() async throws {
        let rig = Rig()
        let a = await rig.desktop("a"), b = await rig.desktop("b")
        a.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let ca = rig.factory.connection(for: rig.record(for: a))
        let ea = EventRecorder(ca)
        await ca.start()
        let ia = try await ea.waitFor(Self.isInbox)

        b.offer()
        let cb = rig.factory.pairingConnection(for: b.invite, deviceName: "Test iPhone")
        let eb = EventRecorder(cb)
        await cb.start()
        try await eb.waitFor { $0 == .pairing(.accepted(desktopName: "b")) }
        try await eb.waitFor(Self.isInbox)
        // `a` came back after the reconnect.
        try await ea.waitFor(after: ia, Self.isInbox)
        #expect(await rig.relay.openPhoneSockets == 1)
        let hellos = await rig.relay.hellos
        #expect(hellos.count == 2)
        guard case .hello(_, _, _, let pair)? = hellos.last else { Issue.record("no hello"); return }
        #expect(pair?.to == b.id)
        await ca.stop()
        await cb.stop()
    }

    @Test func unknownDevice() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor(Self.isState(.unknownDevice))
        await connection.stop()
    }

    @Test func incompatibleNewerDesktop() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        desktop.reply = (5, 4)
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        // The phone (v3) is the older side: "Update the app".
        try await events.waitFor(Self.isState(.incompatible(updateDesktop: false)))
        await connection.stop()
    }

    /// Version 2 (streams) is a hard cutover: a version 1 desktop is refused.
    @Test func incompatibleVersion1Desktop() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        desktop.reply = (1, 1)
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        try await events.waitFor(Self.isState(.incompatible(updateDesktop: true)))
        await connection.stop()
    }

    @Test func resetStartsANewHandshake() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        var i = try await events.waitFor(Self.isInbox)
        let before = desktop.handshakes
        await rig.relay.resetSession(desktop, phone: rig.phone.deviceId)
        i = try await events.waitFor(after: i, Self.isInbox) // re-handshake → inbox.get again
        #expect(desktop.handshakes == before + 1)
        await rig.relay.pushInbox(desktop)
        try await events.waitFor(after: i, Self.isInbox)
        await connection.stop()
    }

    @Test func presenceOfflineOnlineAndRevoked() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        var i = try await events.waitFor(Self.isInbox)

        await rig.relay.setOnline(desktop, false)
        let seen = Date(unixMilliseconds: desktop.lastSeen)
        i = try await events.waitFor(after: i) { $0 == .lastSeen(seen) }
        i = try await events.waitFor(after: i, Self.isState(.offline(lastSeen: seen)))
        await #expect(throws: DesktopConnectionError.desktopOffline) { try await connection.refresh() }

        await rig.relay.setOnline(desktop, true)
        i = try await events.waitFor(after: i, Self.isState(.online))
        i = try await events.waitFor(after: i, Self.isInbox)

        await rig.relay.revoke(desktop, phone: rig.phone.deviceId)
        i = try await events.waitFor(after: i) { $0 == .pairing(.revoked) }
        try await events.waitFor(after: i, Self.isState(.revoked))
        await connection.stop()
    }

    @Test func desktopOfflineAtStart() async throws {
        let rig = Rig()
        let desktop = await rig.desktop()
        desktop.pairings[rig.phone.deviceId] = rig.phone.x25519.pub
        desktop.online = false
        let connection = rig.factory.connection(for: rig.record(for: desktop))
        let events = EventRecorder(connection)
        await connection.start()
        let i = try await events.waitFor {
            if case .state(.offline) = $0 { return true }
            return false
        }
        await rig.relay.setOnline(desktop, true)
        try await events.waitFor(after: i, Self.isInbox)
        await connection.stop()
    }

    @Test func hubKeysNormalizeURL() {
        #expect(RelayHub.key(URL(string: "WSS://Relay.Example/")!) == RelayHub.key(URL(string: "wss://relay.example")!))
        #expect(RelayHub.key(URL(string: "wss://a.example")!) != RelayHub.key(URL(string: "wss://b.example")!))
        let client = RelayClient(relayURL: URL(string: "wss://relay.example/base/")!, identity: .generate())
        #expect(client.endpoint.absoluteString == "wss://relay.example/base/v1")
    }
}
