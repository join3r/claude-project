import Testing
@testable import DevToolKit

/// Cases from the desktop's `tests/new-task.test.ts`, so the phone prefills
/// what the desktop's New stream dialog would.
@Suite struct StreamNamingTests {
    @Test func branchSlugMatchesTheDesktop() {
        #expect(StreamNaming.branchSlug("Fix inbox badge count") == "fix-inbox-badge-count")
        #expect(StreamNaming.branchSlug("fix: the (inbox) badge!!") == "fix-the-inbox-badge")
        #expect(StreamNaming.branchSlug("feature/inbox-v2.1") == "feature/inbox-v2.1")
        #expect(StreamNaming.branchSlug("  --wip--  ") == "wip")
        #expect(StreamNaming.branchSlug("/nested/") == "nested")
        #expect(StreamNaming.branchSlug("bump..version") == "bump.version")
        #expect(StreamNaming.branchSlug("at@{1}") == "at-1")
        #expect(StreamNaming.branchSlug("package.lock") == "package")
        #expect(StreamNaming.branchSlug("a.lock.lock") == "a")
        #expect(StreamNaming.branchSlug("   ") == "")
        #expect(StreamNaming.branchSlug("???") == "")
        #expect(StreamNaming.branchSlug("0.5.1") == "0.5.1")
        #expect(StreamNaming.branchSlug("Chapter 1 ✨ café") == "chapter-1-caf")
    }

    @Test func nextVersions() {
        #expect(StreamNaming.nextVersions("0.4.2")! == ("0.4.3", "0.5.0"))
        #expect(StreamNaming.nextVersions("v1.9.9")! == ("v1.9.10", "v1.10.0"))
        #expect(StreamNaming.nextVersions("0.4")! == ("0.5", "1.0"))
        #expect(StreamNaming.nextVersions(" 0.4.2 ")! == ("0.4.3", "0.5.0"))
        #expect(StreamNaming.nextVersions("bugfixes") == nil)
        #expect(StreamNaming.nextVersions("1.2.3-rc1") == nil)
        #expect(StreamNaming.nextVersions("5") == nil)
        #expect(StreamNaming.nextVersions("١.٢") == nil)
    }

    @Test func suggestsFromTheLastStreamOtherThanMain() {
        let main = InboxStream(id: "m", name: "main", isMain: true)
        #expect(StreamNaming.suggestion(after: [main]) == ("", nil))
        let versions = StreamNaming.suggestion(after: [main, InboxStream(id: "a", name: "0.4.1"), InboxStream(id: "b", name: "0.4.2")])
        #expect(versions == ("0.4.3", "0.5.0"))
        #expect(StreamNaming.suggestion(after: [main, InboxStream(id: "a", name: "0.4.2"), InboxStream(id: "b", name: "bugfixes")]) == ("", nil))
    }

    @Test func defaultBaseBranch() {
        #expect(StreamNaming.defaultBaseBranch(["dev", "master", "main"]) == "main")
        #expect(StreamNaming.defaultBaseBranch(["dev", "master"]) == "master")
        #expect(StreamNaming.defaultBaseBranch(["dev", "topic"]) == "dev")
        #expect(StreamNaming.defaultBaseBranch([]) == "")
    }
}
