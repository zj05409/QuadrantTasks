import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Central task repository shared by the app and the WidgetKit extension.
///
/// Storage strategy: a single JSON file inside the shared App Group container.
/// - 100% offline, no backend, no sync.
/// - Widget reads the same file via `TaskStore.readFromDisk()`.
/// - After every mutation the app calls `WidgetCenter.reloadAllTimelines()`
///   so the home-screen widget refreshes immediately.
final class TaskStore: ObservableObject {

    // MARK: - Configuration

    static let shared = TaskStore()

    /// App Group used for app <-> widget data sharing.
    /// IMPORTANT: if you change the bundle identifiers, update this group id
    /// and the entitlements files of both targets accordingly.
    static let appGroupID = "group.com.zj05409.QuadrantTasks"

    // MARK: - State

    @Published private(set) var tasks: [TaskItem] = []

    /// Where this store persists. Injectable for isolated unit tests.
    private let storeURL: URL

    private init() {
        storeURL = Self.defaultStoreURL
        tasks = Self.read(from: storeURL)
    }

    /// Test-only initializer: same behavior, state stored at a custom location.
    init(storeURL: URL) {
        self.storeURL = storeURL
        tasks = Self.read(from: storeURL)
    }

    // MARK: - Queries

    /// Open (not completed) tasks of a quadrant, oldest first so old tasks stay visible.
    func openTasks(in quadrant: Quadrant) -> [TaskItem] {
        tasks.filter { $0.quadrant == quadrant && !$0.isDone }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Completed tasks of a quadrant, most recently completed first.
    func doneTasks(in quadrant: Quadrant) -> [TaskItem] {
        tasks.filter { $0.quadrant == quadrant && $0.isDone }
            .sorted { ($0.completedAt ?? .distantPast) > ($1.completedAt ?? .distantPast) }
    }

    var openCount: Int { tasks.filter { !$0.isDone }.count }
    var doneCount: Int { tasks.filter { $0.isDone }.count }

    func openCount(in quadrant: Quadrant) -> Int {
        tasks.filter { $0.quadrant == quadrant && !$0.isDone }.count
    }

    // MARK: - Mutations

    func add(title: String, note: String, quadrant: Quadrant) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        tasks.append(TaskItem(title: trimmed,
                              note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                              quadrant: quadrant))
        persist()
    }

    func update(_ task: TaskItem) {
        guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[index] = task
        persist()
    }

    func toggle(_ task: TaskItem) {
        guard let index = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[index].isDone.toggle()
        tasks[index].completedAt = tasks[index].isDone ? Date() : nil
        persist()
    }

    func delete(_ task: TaskItem) {
        tasks.removeAll { $0.id == task.id }
        persist()
    }

    func delete(ids: Set<UUID>) {
        tasks.removeAll { ids.contains($0.id) }
        persist()
    }

    // MARK: - Persistence

    /// Shared App Group container location. Falls back to Documents with a loud log
    /// when the group is misconfigured (widget sync would silently break otherwise).
    static var defaultStoreURL: URL {
        if let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID) {
            return container.appendingPathComponent("tasks.json")
        }
        NSLog("QuadrantTasks: App Group '\(appGroupID)' unavailable; "
            + "falling back to Documents (widget will not sync). Check entitlements.")
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tasks.json")
    }

    /// Snapshot read used by the widget timeline provider (no ObservableObject needed).
    static func readFromDisk() -> [TaskItem] {
        read(from: defaultStoreURL)
    }

    static func read(from url: URL) -> [TaskItem] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([TaskItem].self, from: data)) ?? []
    }

    private func persist() {
        do {
            let data = try JSONEncoder().encode(tasks)
            try data.write(to: storeURL, options: .atomic)
        } catch {
            assertionFailure("Failed to persist tasks: \(error)")
        }
        // Ask the system to refresh the home-screen widget timeline.
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }
}
