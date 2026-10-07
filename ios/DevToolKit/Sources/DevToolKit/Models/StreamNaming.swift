import Foundation

/// The New stream sheet's prefills, mirroring the desktop's New stream dialog
/// (`src/renderer/components/newStream.ts`, `src/shared/branch-name.ts`).
public enum StreamNaming {
    /// The next versions after `name` when it reads as one: `0.4.2` → next
    /// `0.4.3`, minor `0.5.0`; `0.4` → next `0.5`, minor `1.0`. A `v` prefix
    /// is kept. Nil for anything else.
    public static func nextVersions(_ name: String) -> (next: String, minor: String)? {
        let text = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = versionPattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        func group(_ i: Int) -> String? {
            Range(match.range(at: i), in: text).map { String(text[$0]) }
        }
        guard let majorText = group(2), let minorText = group(3),
              let major = Int(majorText), let minor = Int(minorText) else { return nil }
        let v = group(1) ?? ""
        guard let patchText = group(4) else {
            return ("\(v)\(major).\(minor + 1)", "\(v)\(major + 1).0")
        }
        guard let patch = Int(patchText) else { return nil }
        return ("\(v)\(major).\(minor).\(patch + 1)", "\(v)\(major).\(minor + 1).0")
    }

    /// What the sheet suggests: the next version after the project's last
    /// stream (the last one other than `main`) when its name looks like a
    /// version, else an empty name and no minor.
    public static func suggestion(after streams: [InboxStream]) -> (name: String, minor: String?) {
        guard let last = streams.last(where: { !$0.isMain }), let versions = nextVersions(last.name) else {
            return ("", nil)
        }
        return (versions.next, versions.minor)
    }

    /// Git-safe branch name from a free-form name: the desktop's `branchSlug`,
    /// rule for rule (UTF-16 regexes, as JavaScript runs them).
    public static func branchSlug(_ name: String) -> String {
        var slug = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for (pattern, replacement) in slugSteps {
            slug = pattern.stringByReplacingMatches(in: slug, range: NSRange(slug.startIndex..., in: slug), withTemplate: replacement)
        }
        while slug.hasSuffix(".lock") {
            slug = String(slug.dropLast(".lock".count))
            slug = trailingSeparators.stringByReplacingMatches(in: slug, range: NSRange(slug.startIndex..., in: slug), withTemplate: "")
        }
        return slug
    }

    /// The branch a worktree forks from by default: main, then master, then
    /// the first one, else "".
    public static func defaultBaseBranch(_ branches: [String]) -> String {
        branches.first { $0 == "main" } ?? branches.first { $0 == "master" } ?? branches.first ?? ""
    }

    // `[0-9]`, not `\d`: JavaScript's `\d` is ASCII only.
    nonisolated(unsafe) private static let versionPattern = try! NSRegularExpression(pattern: "^(v?)([0-9]+)\\.([0-9]+)(?:\\.([0-9]+))?$")
    nonisolated(unsafe) private static let trailingSeparators = try! NSRegularExpression(pattern: "[-._/]+$")
    nonisolated(unsafe) private static let slugSteps: [(NSRegularExpression, String)] = [
        (try! NSRegularExpression(pattern: "[^a-z0-9._/-]+"), "-"),
        (try! NSRegularExpression(pattern: "\\.{2,}"), "."),
        (try! NSRegularExpression(pattern: "-{2,}"), "-"),
        (try! NSRegularExpression(pattern: "/{2,}"), "/"),
        (try! NSRegularExpression(pattern: "^[-._/]+"), ""),
        (trailingSeparators, ""),
    ]
}
