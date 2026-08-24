import SwiftUI

/// Home screen: 2x2 Eisenhower board with live counts and quick task toggles.
struct ContentView: View {
    @EnvironmentObject private var store: TaskStore
    @Binding var path: [Quadrant]
    @State private var showAddSheet = false

    private let columns = [GridItem(.flexible(), spacing: 12),
                           GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statsHeader
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(Quadrant.allCases) { quadrant in
                            QuadrantCardView(quadrant: quadrant) {
                                path.append(quadrant)
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("四象限任务")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddSheet = true } label: {
                        Image(systemName: "plus.circle.fill").font(.title3)
                    }
                }
            }
            .navigationDestination(for: Quadrant.self) { quadrant in
                QuadrantDetailView(quadrant: quadrant)
            }
            .sheet(isPresented: $showAddSheet) {
                TaskEditSheet(mode: .add(defaultQuadrant: .urgentImportant))
            }
        }
    }

    /// Global statistics, updates automatically because `store.tasks` is @Published.
    private var statsHeader: some View {
        HStack(spacing: 16) {
            Label("进行中 \(store.openCount)", systemImage: "circle.dashed")
                .foregroundStyle(.primary)
            Label("已完成 \(store.doneCount)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Spacer()
        }
        .font(.subheadline)
        .padding(.horizontal, 4)
    }
}

/// One quadrant cell on the board: title, open-task count and up to 3 quick rows.
struct QuadrantCardView: View {
    @EnvironmentObject private var store: TaskStore
    let quadrant: Quadrant
    let onTap: () -> Void

    private var openTasks: [TaskItem] { store.openTasks(in: quadrant) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: quadrant.symbolName)
                    .foregroundStyle(quadrant.color)
                Text(quadrant.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(openTasks.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(quadrant.color, in: Capsule())
            }

            Text(quadrant.hint)
                .font(.caption2)
                .foregroundStyle(.secondary)

            Divider()

            if openTasks.isEmpty {
                Text("暂无任务")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 8)
            } else {
                ForEach(openTasks.prefix(3)) { task in
                    Button { store.toggle(task) } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "circle")
                                .font(.caption2)
                                .foregroundStyle(quadrant.color)
                            Text(task.title)
                                .font(.caption)
                                .lineLimit(1)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if openTasks.count > 3 {
                    Text("还有 \(openTasks.count - 3) 项…")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(minHeight: 150, alignment: .topLeading)
        .background(quadrant.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(quadrant.color.opacity(0.25), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture(perform: onTap)
    }
}
