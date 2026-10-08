import Foundation

/// A small block-level Markdown splitter for chat text. SwiftUI `Text` renders
/// only inline Markdown well (a fully parsed `AttributedString` loses paragraph
/// breaks and list markers), so the app splits a message into blocks here and
/// renders each block's inline Markdown with `AttributedString(markdown:)`.
///
/// Supported: paragraphs, ATX headings, bullet and ordered list items (one
/// level of nesting by indent), block quotes, fenced code blocks, GFM pipe
/// tables, and thematic breaks. Anything else is a paragraph. Streaming text with an
/// unclosed fence renders the rest as code.
public enum MarkdownBlock: Sendable, Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    /// `marker` is "•" for bullets, or "1." etc. for ordered items.
    case listItem(marker: String, indent: Int, text: String)
    case quote(String)
    case code(language: String?, text: String)
    /// A GFM pipe table. Every row has as many cells as `header`.
    case table(header: [String], alignments: [TableAlignment], rows: [[String]])
    case rule

    public enum TableAlignment: Sendable, Equatable {
        case leading, center, trailing
    }

    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var fence: (marker: String, language: String?, lines: [String])?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushQuote() {
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }
        func flush() {
            flushParagraph()
            flushQuote()
        }

        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if var open = fence {
                if trimmed.hasPrefix(open.marker), trimmed.allSatisfy({ String($0) == String(open.marker.first!) }) {
                    blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    open.lines.append(line)
                    fence = open
                }
                continue
            }

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let marker = String(trimmed.prefix { $0 == trimmed.first })
                let info = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
                fence = (marker, info.isEmpty ? nil : String(info.split(separator: " ").first ?? ""), [])
                continue
            }

            if trimmed.isEmpty {
                flush()
                continue
            }

            if let heading = Self.heading(trimmed) {
                flush()
                blocks.append(heading)
                continue
            }

            if Self.isRule(trimmed) {
                flush()
                blocks.append(.rule)
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var body = trimmed.dropFirst()
                if body.first == " " { body = body.dropFirst() }
                quote.append(String(body))
                continue
            }

            // A header row followed by a delimiter row starts a table; body
            // rows run until a blank line or a line without a pipe.
            if index < lines.count, line.contains("|"),
               let alignments = Self.tableDelimiter(lines[index]) {
                let header = Self.tableCells(line)
                if header.count == alignments.count {
                    flush()
                    index += 1
                    var rows: [[String]] = []
                    while index < lines.count {
                        let row = lines[index].trimmingCharacters(in: .whitespaces)
                        guard !row.isEmpty, row.contains("|") else { break }
                        var cells = Self.tableCells(row)
                        if cells.count < header.count {
                            cells += Array(repeating: "", count: header.count - cells.count)
                        }
                        rows.append(Array(cells.prefix(header.count)))
                        index += 1
                    }
                    blocks.append(.table(header: header, alignments: alignments, rows: rows))
                    continue
                }
            }

            if let item = Self.listItem(line) {
                flush()
                blocks.append(item)
                continue
            }

            flushQuote()
            // A continuation line of a list item joins that item.
            if paragraph.isEmpty, case .listItem(let marker, let indent, let text)? = blocks.last, line.first == " " {
                blocks[blocks.count - 1] = .listItem(marker: marker, indent: indent, text: text + "\n" + trimmed)
                continue
            }
            paragraph.append(line)
        }
        if let open = fence {
            blocks.append(.code(language: open.language, text: open.lines.joined(separator: "\n")))
        }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // Optional closing hashes.
        while text.hasSuffix("#") { text.removeLast() }
        return .heading(level: hashes, text: text.trimmingCharacters(in: .whitespaces))
    }

    /// Cells of a pipe-table row, with the optional outer pipes dropped.
    /// `\|` stays a literal pipe inside a cell.
    private static func tableCells(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|"), !row.hasSuffix("\\|") { row.removeLast() }
        var cells: [String] = []
        var cell = ""
        var escaped = false
        for char in row {
            if escaped {
                cell.append(char == "|" ? "|" : "\\\(char)")
                escaped = false
            } else if char == "\\" {
                escaped = true
            } else if char == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(char)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// The column alignments of a delimiter row like `| :--- | :-: | --: |`,
    /// or nil when the line isn't one.
    private static func tableDelimiter(_ line: String) -> [TableAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") || trimmed.allSatisfy({ ":- ".contains($0) }) else { return nil }
        var alignments: [TableAlignment] = []
        for cell in tableCells(trimmed) {
            guard cell.count >= 1, cell.allSatisfy({ $0 == "-" || $0 == ":" }), cell.contains("-") else { return nil }
            let dashes = cell.drop { $0 == ":" }.prefix { $0 == "-" }
            guard dashes.count == cell.filter({ $0 == "-" }).count else { return nil }
            switch (cell.hasPrefix(":"), cell.hasSuffix(":")) {
            case (true, true): alignments.append(.center)
            case (false, true): alignments.append(.trailing)
            default: alignments.append(.leading)
            }
        }
        return alignments
    }

    private static func isRule(_ line: String) -> Bool {
        let chars = line.filter { $0 != " " }
        guard chars.count >= 3, let first = chars.first, "-*_".contains(first) else { return false }
        return chars.allSatisfy { $0 == first }
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let leading = line.prefix { $0 == " " || $0 == "\t" }
        let indent = leading.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) } >= 2 ? 1 : 0
        let body = line.dropFirst(leading.count)
        if let first = body.first, "-*+".contains(first), body.dropFirst().first == " " {
            var text = String(body.dropFirst(2))
            // Task list checkboxes.
            if text.hasPrefix("[ ] ") {
                return .listItem(marker: "☐", indent: indent, text: String(text.dropFirst(4)))
            }
            if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") {
                text = String(text.dropFirst(4))
                return .listItem(marker: "☑", indent: indent, text: text)
            }
            return .listItem(marker: "•", indent: indent, text: text)
        }
        let digits = body.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 9 {
            let after = body.dropFirst(digits.count)
            if let delimiter = after.first, delimiter == "." || delimiter == ")", after.dropFirst().first == " " {
                return .listItem(marker: "\(digits).", indent: indent, text: String(after.dropFirst(2)))
            }
        }
        return nil
    }
}
