import DevToolKit
import SwiftUI

/// Chat Markdown: blocks from `MarkdownBlock.parse`, each block's inline
/// Markdown (bold, italics, `code`, links) through `AttributedString(markdown:)`,
/// shown in `LinkText` so links can be tapped and copied. No syntax highlighting.
struct MarkdownText: View {
    let markdown: String
    var font: UIFont.TextStyle = .body

    var body: some View {
        let blocks = MarkdownBlock.parse(markdown)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .font(Font(UIFont.preferredFont(forTextStyle: font)))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            LinkText(text: LinkText.attributed(Self.inline(text), style: font))
        case .heading(let level, let text):
            LinkText(text: LinkText.attributed(
                Self.inline(text),
                style: level <= 1 ? .title3 : level == 2 ? .headline : .subheadline,
                bold: level != 2
            ))
            .padding(.top, 2)
        case .listItem(let marker, let indent, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 14, alignment: .trailing)
                LinkText(text: LinkText.attributed(Self.inline(text), style: font))
            }
            .padding(.leading, CGFloat(indent) * 18)
        case .quote(let text):
            LinkText(text: LinkText.attributed(Self.inline(text), style: font, color: .secondaryLabel))
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(width: 3)
                }
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .table(let header, let alignments, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(header.indices, id: \.self) { column in
                            tableCell(header[column], alignment: alignments[column], bold: true)
                        }
                    }
                    .background(Color(.tertiarySystemFill))
                    ForEach(rows.indices, id: \.self) { row in
                        Divider()
                        GridRow {
                            ForEach(header.indices, id: \.self) { column in
                                tableCell(rows[row][column], alignment: alignments[column])
                            }
                        }
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.quaternary))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    private func tableCell(_ text: String, alignment: MarkdownBlock.TableAlignment, bold: Bool = false) -> some View {
        let frameAlignment: Alignment = switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
        let textAlignment: NSTextAlignment = switch alignment {
        case .leading: .natural
        case .center: .center
        case .trailing: .right
        }
        return LinkText(
            text: LinkText.attributed(Self.inline(text), style: .subheadline, bold: bold, alignment: textAlignment),
            maxWidth: 260
        )
        .frame(maxWidth: 260, alignment: frameAlignment)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .gridColumnAlignment(alignment == .trailing ? .trailing : alignment == .center ? .center : .leading)
    }

    /// Inline Markdown, keeping line breaks. Falls back to the plain text when it doesn't parse.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
