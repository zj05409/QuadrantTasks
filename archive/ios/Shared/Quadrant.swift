import SwiftUI

/// The four quadrants of the Eisenhower matrix.
/// Raw values are stable because they are persisted and used in deep links.
enum Quadrant: Int, Codable, CaseIterable, Identifiable, Hashable {
    case urgentImportant = 0        // 重要且紧急
    case importantNotUrgent = 1     // 重要不紧急
    case urgentNotImportant = 2     // 紧急不重要
    case neitherUrgentNorImportant = 3 // 不紧急不重要

    var id: Int { rawValue }

    /// Display title (Chinese, matches the classic Eisenhower wording).
    var title: String {
        switch self {
        case .urgentImportant: return "重要且紧急"
        case .importantNotUrgent: return "重要不紧急"
        case .urgentNotImportant: return "紧急不重要"
        case .neitherUrgentNorImportant: return "不紧急不重要"
        }
    }

    /// Short strategy hint shown under the title.
    var hint: String {
        switch self {
        case .urgentImportant: return "立即去做"
        case .importantNotUrgent: return "计划去做"
        case .urgentNotImportant: return "尽量减少"
        case .neitherUrgentNorImportant: return "偶尔为之"
        }
    }

    /// Accent color of the quadrant. Uses semantic variants so dark/light mode adapt automatically.
    var color: Color {
        switch self {
        case .urgentImportant: return .red
        case .importantNotUrgent: return .blue
        case .urgentNotImportant: return .orange
        case .neitherUrgentNorImportant: return .gray
        }
    }

    var symbolName: String {
        switch self {
        case .urgentImportant: return "flame.fill"
        case .importantNotUrgent: return "star.fill"
        case .urgentNotImportant: return "bell.fill"
        case .neitherUrgentNorImportant: return "leaf.fill"
        }
    }

    /// Deep link used by the home-screen widget to jump straight into this quadrant.
    var deepLinkURL: URL {
        URL(string: "quadranttasks://quadrant/\(rawValue)")!
    }

    /// Parse a deep link such as `quadranttasks://quadrant/2`.
    static func from(url: URL) -> Quadrant? {
        guard url.scheme == "quadranttasks", url.host == "quadrant" else { return nil }
        let raw = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return Int(raw).flatMap(Quadrant.init(rawValue:))
    }
}
