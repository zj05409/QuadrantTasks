import Foundation

/// A single task in the Eisenhower matrix.
/// Pure value type, Codable for JSON persistence inside the shared App Group container.
struct TaskItem: Codable, Identifiable, Hashable {
    var id: UUID
    var title: String
    var note: String
    var quadrant: Quadrant
    var isDone: Bool
    var createdAt: Date
    var completedAt: Date?

    init(id: UUID = UUID(),
         title: String,
         note: String = "",
         quadrant: Quadrant,
         isDone: Bool = false,
         createdAt: Date = Date(),
         completedAt: Date? = nil) {
        self.id = id
        self.title = title
        self.note = note
        self.quadrant = quadrant
        self.isDone = isDone
        self.createdAt = createdAt
        self.completedAt = completedAt
    }
}
