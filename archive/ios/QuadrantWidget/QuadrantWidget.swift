import WidgetKit
import SwiftUI

// MARK: - Timeline

struct QuadrantEntry: TimelineEntry {
    let date: Date
    let tasks: [TaskItem]

    func openTasks(in quadrant: Quadrant) -> [TaskItem] {
        tasks.filter { $0.quadrant == quadrant && !$0.isDone }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Sample content shown in the widget gallery.
    static var preview: QuadrantEntry {
        QuadrantEntry(date: Date(), tasks: [
            TaskItem(title: "准备明天汇报", quadrant: .urgentImportant),
            TaskItem(title: "背 50 个六级单词", quadrant: .importantNotUrgent),
            TaskItem(title: "回复工作群消息", quadrant: .urgentNotImportant),
            TaskItem(title: "刷会儿短视频", quadrant: .neitherUrgentNorImportant)
        ])
    }
}

struct QuadrantTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuadrantEntry { .preview }

    func getSnapshot(in context: Context, completion: @escaping (QuadrantEntry) -> Void) {
        completion(QuadrantEntry(date: Date(), tasks: TaskStore.readFromDisk()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuadrantEntry>) -> Void) {
        let now = Date()
        let entry = QuadrantEntry(date: now, tasks: TaskStore.readFromDisk())
        // Periodic fallback refresh; real-time refresh is triggered by the app
        // via WidgetCenter.reloadAllTimelines() whenever tasks change.
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: now) ?? now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

struct QuadrantWidgetEntryView: View {
    let entry: QuadrantEntry

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                QuadrantCellView(quadrant: .urgentImportant, tasks: entry.openTasks(in: .urgentImportant))
                QuadrantCellView(quadrant: .importantNotUrgent, tasks: entry.openTasks(in: .importantNotUrgent))
            }
            HStack(spacing: 10) {
                QuadrantCellView(quadrant: .urgentNotImportant, tasks: entry.openTasks(in: .urgentNotImportant))
                QuadrantCellView(quadrant: .neitherUrgentNorImportant, tasks: entry.openTasks(in: .neitherUrgentNorImportant))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// One quadrant cell. Wrapped in a `Link` so tapping it jumps into the app's quadrant page.
private struct QuadrantCellView: View {
    let quadrant: Quadrant
    let tasks: [TaskItem]

    private let maxVisible = 4

    var body: some View {
        Link(destination: quadrant.deepLinkURL) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: quadrant.symbolName)
                        .font(.caption2)
                        .foregroundStyle(quadrant.color)
                    Text(quadrant.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Text("\(tasks.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(quadrant.color, in: Capsule())
                }

                if tasks.isEmpty {
                    Spacer(minLength: 0)
                    Text("无任务")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Spacer(minLength: 0)
                } else {
                    ForEach(tasks.prefix(maxVisible)) { task in
                        HStack(spacing: 4) {
                            Circle()
                                .strokeBorder(quadrant.color, lineWidth: 1.2)
                                .frame(width: 8, height: 8)
                            Text(task.title)
                                .font(.caption2)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                    if tasks.count > maxVisible {
                        Text("还有 \(tasks.count - maxVisible) 项…")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(quadrant.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - Widget

struct QuadrantWidget: Widget {
    let kind = "QuadrantWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: QuadrantTimelineProvider()) { entry in
            QuadrantWidgetEntryView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("四象限任务")
        .description("在主屏直接查看艾森豪威尔四象限任务列表，点击象限进入对应页面。")
        // Only the large home-screen widget is provided (by design, no lock-screen widget).
        .supportedFamilies([.systemLarge])
    }
}
