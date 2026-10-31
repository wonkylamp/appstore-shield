import SwiftUI
import FirebaseCore

@main
struct CompanionApp: App {
    @StateObject private var session = SessionStore()

    init() {
        FirebaseApp.configure()
        RemoteFlags.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @AppStorage("hasOnboarded") private var hasOnboarded = false

    var body: some View {
        if session.user == nil {
            SignUpView()
        } else if !hasOnboarded {
            OnboardingView { hasOnboarded = true }
        } else {
            TabView {
                ChatView()
                    .tabItem { Label("Luna", systemImage: "heart.text.square") }
                CompanionStudioView()
                    .tabItem { Label("Studio", systemImage: "paintpalette") }
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
            }
            #if DEBUG
            .overlay(alignment: .bottomTrailing) { DebugMenuButton() }
            #endif
        }
    }
}

struct OnboardingView: View {
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Meet Luna").font(.largeTitle.bold())
            Text("Your companion remembers your day and is always up for a chat.")
                .multilineTextAlignment(.center)
            Button("Continue", action: onDone).buttonStyle(.borderedProminent)
        }
        .padding()
        .onAppear { UserDefaults.standard.set(Date(), forKey: "firstLaunchAt") }
    }
}
