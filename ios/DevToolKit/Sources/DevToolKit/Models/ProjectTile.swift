import Foundation

/// How a project looks wherever one of its tasks or streams shows up outside its
/// own screen: its emoji, else its initials, on a colour from the project id.
/// Mirrors the desktop's `src/shared/project-label.ts` (SPEC.md §10,
/// `protocol/vectors/project-tile.json`), so a project looks the same on both apps.
public struct ProjectTile: Sendable, Equatable {
    /// Up to two initials; always set, for when there is no emoji.
    public var text: String
    public var emoji: String?
    /// Index into `ProjectTile.palette`.
    public var hue: Int

    public init(id: String, name: String, emoji: String? = nil) {
        text = Self.initials(name)
        let trimmed = emoji?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.emoji = trimmed?.isEmpty == false ? trimmed : nil
        hue = Self.hue(id)
    }

    public var swatch: Swatch { Self.palette[hue % Self.palette.count] }

    /// One tile colour per theme, as `0xRRGGBB`.
    public struct Swatch: Sendable, Equatable {
        public var name: String
        public var lightBg: UInt32
        public var lightFg: UInt32
        public var darkBg: UInt32
        public var darkFg: UInt32
    }

    /// The fixed palette a project id hashes into. Order is part of the spec (§10).
    public static let palette: [Swatch] = [
        Swatch(name: "red", lightBg: 0xfde2e1, lightFg: 0xb42318, darkBg: 0x4a1d1b, darkFg: 0xfca5a0),
        Swatch(name: "orange", lightBg: 0xfde8d4, lightFg: 0xb54708, darkBg: 0x4a2a12, darkFg: 0xfdba74),
        Swatch(name: "amber", lightBg: 0xfbf0c8, lightFg: 0x8a6100, darkBg: 0x43360f, darkFg: 0xfcd34d),
        Swatch(name: "green", lightBg: 0xdcf3e2, lightFg: 0x1f7a3d, darkBg: 0x173d24, darkFg: 0x86efac),
        Swatch(name: "teal", lightBg: 0xd5f2ef, lightFg: 0x0f766e, darkBg: 0x123c39, darkFg: 0x5eead4),
        Swatch(name: "blue", lightBg: 0xdbe8fe, lightFg: 0x1d4ed8, darkBg: 0x1a2e55, darkFg: 0x93c5fd),
        Swatch(name: "violet", lightBg: 0xebe3fd, lightFg: 0x6d28d9, darkBg: 0x33224f, darkFg: 0xc4b5fd),
        Swatch(name: "pink", lightBg: 0xfbe0ee, lightFg: 0xbe185d, darkBg: 0x4a1a33, darkFg: 0xf9a8d4),
    ]

    /// FNV-1a 32-bit over the UTF-8 bytes of `text`.
    public static func fnv1a32(_ text: String) -> UInt32 {
        var hash: UInt32 = 0x811c9dc5
        for byte in text.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return hash
    }

    public static func hue(_ projectId: String) -> Int {
        Int(fnv1a32(projectId) % UInt32(palette.count))
    }

    /// Words are runs of letters and digits (anything else separates them), and a
    /// run also breaks where a lowercase letter meets an uppercase one (`devTool`).
    /// Two or more words give their first characters; one word its first two; none,
    /// the name's first character; an empty name `?`. Works on Unicode scalars,
    /// uppercased.
    public static func initials(_ name: String) -> String {
        var words: [[Unicode.Scalar]] = []
        var word: [Unicode.Scalar] = []
        for scalar in name.unicodeScalars {
            let category = scalar.properties.generalCategory
            guard isWordCategory(category) else {
                if !word.isEmpty { words.append(word) }
                word = []
                continue
            }
            if let prev = word.last, prev.properties.generalCategory == .lowercaseLetter,
               category == .uppercaseLetter {
                words.append(word)
                word = []
            }
            word.append(scalar)
        }
        if !word.isEmpty { words.append(word) }

        let picked: [Unicode.Scalar]
        if words.count >= 2 {
            picked = [words[0][0], words[1][0]]
        } else if let only = words.first {
            picked = Array(only.prefix(2))
        } else if let first = name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.first {
            picked = [first]
        } else {
            return "?"
        }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: picked)
        return String(out).uppercased()
    }

    private static func isWordCategory(_ category: Unicode.GeneralCategory) -> Bool {
        switch category {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            true
        default:
            false
        }
    }

    /// `project › stream`, or just `project` on the `main` stream or with no stream.
    public static func place(project: String, stream: String?, isMain: Bool = false) -> String {
        guard let stream, !stream.isEmpty, !isMain else { return project }
        return "\(project) › \(stream)"
    }
}

public extension InboxProject {
    var tile: ProjectTile { ProjectTile(id: id, name: name, emoji: emoji) }

    /// `project › stream` for a task of this project (just `project` on `main`).
    func place(of task: InboxTask) -> String {
        let stream = streams.first(where: { $0.id == task.streamId })
        return ProjectTile.place(project: name, stream: stream?.name ?? task.streamName,
                                 isMain: stream?.isMain ?? false)
    }

    func place(of stream: InboxStream) -> String {
        ProjectTile.place(project: name, stream: stream.name, isMain: stream.isMain)
    }
}
