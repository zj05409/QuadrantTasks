import XCTest
@testable import QuadrantTasks

final class QuadrantDeepLinkTests: XCTestCase {

    func testValidDeepLinks() {
        XCTAssertEqual(Quadrant.from(url: URL(string: "quadranttasks://quadrant/0")!), .urgentImportant)
        XCTAssertEqual(Quadrant.from(url: URL(string: "quadranttasks://quadrant/1")!), .importantNotUrgent)
        XCTAssertEqual(Quadrant.from(url: URL(string: "quadranttasks://quadrant/2")!), .urgentNotImportant)
        XCTAssertEqual(Quadrant.from(url: URL(string: "quadranttasks://quadrant/3")!), .neitherUrgentNorImportant)
    }

    func testDeepLinkRoundTrip() {
        for quadrant in Quadrant.allCases {
            XCTAssertEqual(Quadrant.from(url: quadrant.deepLinkURL), quadrant)
        }
    }

    func testInvalidDeepLinks() {
        XCTAssertNil(Quadrant.from(url: URL(string: "quadranttasks://quadrant/4")!))
        XCTAssertNil(Quadrant.from(url: URL(string: "quadranttasks://wrong/1")!))
        XCTAssertNil(Quadrant.from(url: URL(string: "https://quadrant/1")!))
        XCTAssertNil(Quadrant.from(url: URL(string: "quadranttasks://quadrant/abc")!))
    }
}

final class TaskItemCodableTests: XCTestCase {

    func testRoundTrip() throws {
        let task = TaskItem(title: "背单词", note: "50 个", quadrant: .importantNotUrgent,
                            isDone: true, createdAt: Date(timeIntervalSince1970: 1000),
                            completedAt: Date(timeIntervalSince1970: 2000))
        let data = try JSONEncoder().encode(task)
        let decoded = try JSONDecoder().decode(TaskItem.self, from: data)
        XCTAssertEqual(decoded, task)
        XCTAssertEqual(decoded.completedAt, Date(timeIntervalSince1970: 2000))
    }

    func testDefaults() {
        let task = TaskItem(title: "x", quadrant: .urgentImportant)
        XCTAssertFalse(task.isDone)
        XCTAssertNil(task.completedAt)
        XCTAssertEqual(task.note, "")
    }
}

/// TaskStore with an isolated temp file (never touches the real App Group data).
final class TaskStoreTests: XCTestCase {

    private func makeStore() -> (TaskStore, URL) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("qt_test_\(UUID().uuidString).json")
        return (TaskStore(storeURL: url), url)
    }

    func testAddAndQuery() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "任务A", note: "", quadrant: .urgentImportant)
        store.add(title: "任务B", note: "备注", quadrant: .urgentImportant)
        store.add(title: "任务C", note: "", quadrant: .neitherUrgentNorImportant)

        XCTAssertEqual(store.openTasks(in: .urgentImportant).count, 2)
        XCTAssertEqual(store.openTasks(in: .importantNotUrgent).count, 0)
        XCTAssertEqual(store.openCount, 3)
        XCTAssertEqual(store.doneCount, 0)
    }

    func testAddRejectsBlankTitle() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "   ", note: "", quadrant: .urgentImportant)
        XCTAssertEqual(store.openCount, 0)
    }

    func testToggleCompletion() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "完成任务", note: "", quadrant: .urgentNotImportant)
        let task = store.openTasks(in: .urgentNotImportant).first!
        store.toggle(task)

        XCTAssertEqual(store.openCount, 0)
        XCTAssertEqual(store.doneCount, 1)
        let done = store.doneTasks(in: .urgentNotImportant).first!
        XCTAssertNotNil(done.completedAt)

        // Toggle back.
        store.toggle(done)
        XCTAssertEqual(store.openCount, 1)
        XCTAssertNil(store.openTasks(in: .urgentNotImportant).first!.completedAt)
    }

    func testUpdate() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "旧标题", note: "", quadrant: .urgentImportant)
        var task = store.tasks.first!
        task.title = "新标题"
        task.quadrant = .importantNotUrgent
        store.update(task)

        XCTAssertEqual(store.openTasks(in: .urgentImportant).count, 0)
        XCTAssertEqual(store.openTasks(in: .importantNotUrgent).first?.title, "新标题")
    }

    func testDelete() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "A", note: "", quadrant: .urgentImportant)
        store.add(title: "B", note: "", quadrant: .urgentImportant)
        store.delete(store.tasks.first!)
        XCTAssertEqual(store.tasks.count, 1)

        store.delete(ids: Set(store.tasks.map(\.id)))
        XCTAssertEqual(store.tasks.count, 0)
    }

    func testPersistenceAcrossInstances() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "持久化", note: "note", quadrant: .importantNotUrgent)
        store.toggle(store.tasks.first!)

        let reloaded = TaskStore(storeURL: url)
        XCTAssertEqual(reloaded.tasks.count, 1)
        XCTAssertEqual(reloaded.doneCount, 1)
        XCTAssertEqual(reloaded.tasks.first?.note, "note")

        // The static snapshot reader (used by the widget) sees the same file.
        let snapshot = TaskStore.read(from: url)
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertTrue(snapshot.first!.isDone)
    }

    func testOpenTasksSortedOldestFirst() {
        let (store, url) = makeStore()
        defer { try? FileManager.default.removeItem(at: url) }

        store.add(title: "first", note: "", quadrant: .urgentImportant)
        // Ensure a measurable time gap.
        Thread.sleep(forTimeInterval: 0.01)
        store.add(title: "second", note: "", quadrant: .urgentImportant)

        let open = store.openTasks(in: .urgentImportant)
        XCTAssertEqual(open.map(\.title), ["first", "second"])
    }
}
