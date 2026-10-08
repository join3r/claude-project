import Testing
@testable import DevToolKit

@Suite struct MarkdownBlockTests {
    @Test func parsesPipeTable() {
        let blocks = MarkdownBlock.parse("""
        Intro
        | Name | Count | Note |
        | :--- | ----: | :--: |
        | a | 1 | `x \\| y` |
        | b | 2 |

        After
        """)
        #expect(blocks == [
            .paragraph("Intro"),
            .table(
                header: ["Name", "Count", "Note"],
                alignments: [.leading, .trailing, .center],
                rows: [["a", "1", "`x | y`"], ["b", "2", ""]]),
            .paragraph("After"),
        ])
    }

    @Test func tableWithoutOuterPipes() {
        let blocks = MarkdownBlock.parse("a | b\n--- | ---\n1 | 2")
        #expect(blocks == [.table(header: ["a", "b"], alignments: [.leading, .leading], rows: [["1", "2"]])])
    }

    @Test func pipeWithoutDelimiterIsParagraph() {
        #expect(MarkdownBlock.parse("a | b\nc | d") == [.paragraph("a | b\nc | d")])
    }

    @Test func mismatchedDelimiterIsNotTable() {
        let blocks = MarkdownBlock.parse("| a | b |\n| --- |")
        #expect(!blocks.contains { if case .table = $0 { true } else { false } })
    }
}
