import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var session: SessionStore
    @AppStorage("companionName") private var companionName = "Luna"
    @State private var nameDraft = ""
    @State private var showPaywall = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Companion") {
                    TextField("Name", text: $nameDraft)
                        .onSubmit {
                            if NameFilter.isAllowed(nameDraft) { companionName = nameDraft }
                        }
                }
                Section("Subscription") {
                    Button("Upgrade to Premium") { showPaywall = true }
                }
                Section("Support") {
                    Link("Contact support", destination: URL(string: "mailto:support@lunacompanion.app")!)
                    Link("Privacy Policy", destination: URL(string: "https://lunacompanion.app/privacy")!)
                }
                Section {
                    Button("Sign out", role: .destructive) { session.signOut() }
                }
            }
            .navigationTitle("Settings")
            .onAppear { nameDraft = companionName }
            .sheet(isPresented: $showPaywall) { PaywallView() }
        }
    }
}
