import SwiftUI

@main
struct QuadrantTasksApp: App {
    @StateObject private var store = TaskStore.shared
    /// Navigation path so the widget deep link can push straight into a quadrant.
    @State private var path: [Quadrant] = []

    var body: some Scene {
        WindowGroup {
            ContentView(path: $path)
                .environmentObject(store)
                .onOpenURL { url in
                    // Handles quadranttasks://quadrant/<0-3> from the home-screen widget.
                    if let quadrant = Quadrant.from(url: url) {
                        path = [quadrant]
                    }
                }
        }
    }
}
