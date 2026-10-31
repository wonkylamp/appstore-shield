import SwiftUI
import FirebaseCore

@main
struct QuillApp: App {
    @StateObject private var account = AccountService()
    @AppStorage("aiConsentGranted") private var aiConsentGranted = false

    init() {
        FirebaseApp.configure()
        SafetySwitch.shared.refresh()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if account.userID == nil {
                    SignInView()
                } else if !aiConsentGranted {
                    AIConsentView { aiConsentGranted = true }
                } else {
                    TabView {
                        ComposeView()
                            .tabItem { Label("Write", systemImage: "square.and.pencil") }
                        TemplatesView()
                            .tabItem { Label("Templates", systemImage: "doc.on.doc") }
                        SettingsView()
                            .tabItem { Label("Settings", systemImage: "gearshape") }
                    }
                }
            }
            .environmentObject(account)
        }
    }
}
