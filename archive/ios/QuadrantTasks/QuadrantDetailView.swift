import SwiftUI

/// Full task list of one quadrant: complete, edit, delete.
struct QuadrantDetailView: View {
    @EnvironmentObject private var store: TaskStore
    let quadrant: Quadrant

    @State private var editingTask: TaskItem?
    @State private var showAddSheet = false

    var body: some View {
        List {
            Section {
                let open = store.openTasks(in: quadrant)
                if open.isEmpty {
                    Text("暂无进行中的任务")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(open) { task in
                        TaskRowView(task: task) { editingTask = task }
                    }
                }
            } header: {
                Text("未完成 (\(store.openTasks(in: quadrant).count))")
            }

            let done = store.doneTasks(in: quadrant)
            if !done.isEmpty {
                Section("已完成 (\(done.count))") {
                    ForEach(done) { task in
                        TaskRowView(task: task) { editingTask = task }
                    }
                }
            }
        }
        .navigationTitle(quadrant.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAddSheet = true } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(item: $editingTask) { task in
            TaskEditSheet(mode: .edit(task))
        }
        .sheet(isPresented: $showAddSheet) {
            TaskEditSheet(mode: .add(defaultQuadrant: quadrant))
        }
    }
}

/// One task row: tap the circle to complete, tap the text to edit, swipe to delete.
private struct TaskRowView: View {
    @EnvironmentObject private var store: TaskStore
    let task: TaskItem
    let onEdit: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button { store.toggle(task) } label: {
                Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.isDone ? .green : task.quadrant.color)
            }
            .buttonStyle(.plain)

            Button(action: onEdit) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .strikethrough(task.isDone)
                        .foregroundStyle(task.isDone ? .secondary : .primary)
                    if !task.note.isEmpty {
                        Text(task.note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { store.delete(task) } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }
}
