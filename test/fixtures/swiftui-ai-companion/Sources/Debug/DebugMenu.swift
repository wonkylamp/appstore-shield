#if DEBUG
import SwiftUI

struct DebugMenuButton: View {
    @State private var isOpen = false

    var body: some View {
        Button { isOpen = true } label: {
            Image(systemName: "ladybug")
                .padding(12)
                .background(.ultraThinMaterial, in: Circle())
        }
        .padding()
        .sheet(isPresented: $isOpen) { DebugMenu() }
    }
}

struct DebugMenu: View {
    @AppStorage("hasOnboarded") private var hasOnboarded = true

    var body: some View {
        NavigationStack {
            List {
                LabeledContent("Build", value: AppEnvironment.buildNumber)
                LabeledContent("Sandbox receipt", value: AppEnvironment.isTestFlight ? "yes" : "no")
                if AppEnvironment.isTestFlight {
                    Text("Running from TestFlight")
                }
                Button("Replay onboarding") { hasOnboarded = false }
                Button("Clear URL cache") { URLCache.shared.removeAllCachedResponses() }
            }
            .navigationTitle("Debug")
        }
    }
}
#endif
