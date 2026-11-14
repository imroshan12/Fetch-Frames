import SwiftUI

@main
struct FetchFrameApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onOpenURL(perform: model.handleIncoming)
        }
    }
}
