import DevToolKit
import SwiftUI

/// The Inbox's top row (§4.4 `limits`): one tile per Claude account with its
/// 5-hour and weekly windows. Two tiles share the width; more scroll sideways.
struct PlanLimitTiles: View {
    let limits: [InboxPlanLimit]
    let now: Date

    var body: some View {
        if limits.count <= 2 {
            HStack(spacing: 10) {
                ForEach(limits, id: \.account) { tile($0).frame(maxWidth: .infinity) }
            }
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(limits, id: \.account) { tile($0).frame(width: 150) }
                }
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
    }

    private func tile(_ limit: InboxPlanLimit) -> some View {
        PlanLimitTile(limit: limit, name: limit.shortName(among: limits), now: now)
    }
}

/// One account: name and 5-hour percent, the 5-hour bar over the weekly one,
/// the countdown to the next reset. Tap for the details.
private struct PlanLimitTile: View {
    let limit: InboxPlanLimit
    let name: String
    let now: Date

    @State private var showingDetails = false

    var body: some View {
        // A window whose reset has passed is empty until the desktop reads it again.
        let five = limit.fiveHour?.current(now: now)
        let week = limit.sevenDay?.current(now: now)
        let reset = limit.nextReset(now: now)
        Button { showingDetails = true } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    if let five {
                        Text("\(five.used)%")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(UsageTone.limit(five.used))
                    }
                }
                VStack(spacing: 3) {
                    LimitBar(window: five)
                    LimitBar(window: week)
                }
                Text(reset.map { "↺ \(UsageFormat.resetIn($0, now: now))" } ?? " ")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText(five: five, week: week, reset: reset))
        .accessibilityHint("Shows the plan limits")
        .popover(isPresented: $showingDetails, arrowEdge: .top) {
            PlanLimitDetails(limit: limit)
                .presentationCompactAdaptation(.popover)
        }
    }

    private func accessibilityText(five: ChatLimitWindow?, week: ChatLimitWindow?, reset: Int64?) -> String {
        var parts = ["Claude limits for \(limit.account)"]
        if let five { parts.append("5-hour \(five.used)% used") }
        if let week { parts.append("weekly \(week.used)% used") }
        if let reset { parts.append("resets in \(UsageFormat.resetIn(reset, now: now))") }
        return parts.joined(separator: ", ")
    }
}

/// What tapping a tile shows: the account and plan, then each window's use and reset.
private struct PlanLimitDetails: View {
    let limit: InboxPlanLimit

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(limit.account)
                        .font(.subheadline.weight(.semibold))
                    if let plan = limit.plan, !plan.isEmpty {
                        Text("\(plan.capitalized) plan")
                            .foregroundStyle(.secondary)
                    }
                }
                if let five = limit.fiveHour {
                    LimitRow(title: "5-hour limit", window: five.current(now: context.date), now: context.date)
                }
                if let week = limit.sevenDay {
                    LimitRow(title: "Weekly limit", window: week.current(now: context.date), now: context.date)
                }
                if limit.fiveHour == nil && limit.sevenDay == nil {
                    Text("No limits read yet.")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
            .monospacedDigit()
            .padding(16)
            .frame(minWidth: 260)
        }
    }
}
