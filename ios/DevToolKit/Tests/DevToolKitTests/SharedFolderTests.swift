import Testing
@testable import DevToolKit

/// The desktop's `tests/desk-same-folder.test.ts`, on the phone's inbox shape.
@Suite struct SharedFolderTests {
    let main = InboxStream(id: "main", name: "main", isMain: true)
    let folder = InboxStream(id: "f", name: "notes")
    let release = InboxStream(id: "r", name: "release", branch: "release")

    func task(_ id: String, _ stream: InboxStream, working: Bool = true, branch: String? = nil) -> InboxTask {
        InboxTask(id: id, name: id, streamId: stream.id, streamName: stream.name,
                  status: working ? .working : .idle, branch: branch, tabs: [])
    }

    @Test func namesWorkingTasksInTheProjectFolder() {
        let project = InboxProject(id: "p", name: "p", streams: [main, folder, release], tasks: [
            task("a", main), task("b", folder), task("idle", main, working: false),
            task("own", release, branch: "release--own"), task("shared", release)
        ])
        #expect(project.busyInSameFolder(nil).map(\.id) == ["a", "b"])
        #expect(project.busyInSameFolder(folder).map(\.id) == ["a", "b"])
    }

    @Test func quietWhenTheNewTaskGetsItsOwnWorktree() {
        let project = InboxProject(id: "p", name: "p", streams: [main, release], tasks: [task("shared", release)])
        #expect(project.busyInSameFolder(release).isEmpty)
    }

    @Test func overSSHAWorktreeStreamIsShared() {
        let project = InboxProject(id: "p", name: "p", remote: true, streams: [main, release], tasks: [
            task("x", release), task("m", main)
        ])
        let busy = project.busyInSameFolder(release)
        #expect(busy.map(\.id) == ["x"])
        #expect(project.sameFolderWarning(release, busy: busy).hasPrefix("“x” is already working in the release worktree"))
    }
}
