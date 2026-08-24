import SwiftUI

/// Sheet used both for creating and editing a task.
struct TaskEditSheet: View {
    enum Mode: Identifiable {
        case add(defaultQuadrant: Quadrant)
        case edit(TaskItem)

        var id: String {
            switch self {
            case .add: return "add"
            case .edit(let task): return task.id.uuidString
            }
        }
    }

    @EnvironmentObject private var store: TaskStore
    @Environment(\.dismiss) private var dismiss

    let mode: Mode

    @State private var title: String
    @State private var note: String
    @State private var quadrant: Quadrant

    init(mode: Mode) {
        self.mode = mode
        switch mode {
        case .add(let defaultQuadrant):
            _title = State(initialValue: "")
            _note = State(initialValue: "")
            _quadrant = State(initialValue: defaultQuadrant)
        case .edit(let task):
            _title = State(initialValue: task.title)
            _note = State(initialValue: task.note)
            _quadrant = State(initialValue: task.quadrant)
        }
    }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("任务内容") {
                    TextField("标题", text: $title)
                    TextField("备注（可选）", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section("所属象限") {
                    QuadrantPickerView(selection: $quadrant)
                }
            }
            .navigationTitle(isEditing ? "编辑任务" : "新建任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(!canSave)
                }
            }
        }
    }

    private func save() {
        switch mode {
        case .add:
            store.add(title: title, note: note, quadrant: quadrant)
        case .edit(var task):
            task.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            task.note = note.trimmingCharacters(in: .whitespacesAndNewlines)
            task.quadrant = quadrant
            store.update(task)
        }
        dismiss()
    }
}

/// 2x2 chip grid for picking a quadrant (clearer than a cramped segmented control).
struct QuadrantPickerView: View {
    @Binding var selection: Quadrant

    private let columns = [GridItem(.flexible(), spacing: 8),
                           GridItem(.flexible(), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(Quadrant.allCases) { quadrant in
                let selected = quadrant == selection
                Button { selection = quadrant } label: {
                    HStack(spacing: 6) {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(selected ? .white : quadrant.color)
                        Text(quadrant.title)
                            .font(.subheadline.weight(selected ? .semibold : .regular))
                            .foregroundStyle(selected ? .white : .primary)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 10)
                    .background(
                        (selected ? quadrant.color : quadrant.color.opacity(0.10)),
                        in: RoundedRectangle(cornerRadius: 10)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }
}
