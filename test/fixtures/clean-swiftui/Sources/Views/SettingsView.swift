import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var account: AccountService
    @AppStorage("aiConsentGranted") private var aiConsentGranted = true
    @State private var showPaywall = false
    @State private var confirmDelete = false
    @State private var deleteError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Quill Plus") {
                    Button("See plans") { showPaywall = true }
                }
                Section("AI suggestions") {
                    Toggle("Share text with OpenAI for suggestions", isOn: $aiConsentGranted)
                }
                Section("Help") {
                    Link("Contact support", destination: URL(string: "mailto:support@quillwriter.app")!)
                    Link("Privacy Policy", destination: URL(string: "https://quillwriter.app/privacy")!)
                    Link("Terms of Use", destination: URL(string: "https://quillwriter.app/terms")!)
                }
                Section {
                    Button("Sign out") { account.signOut() }
                    Button("Delete account", role: .destructive) { confirmDelete = true }
                }
                if let deleteError {
                    Text(deleteError).foregroundStyle(.red)
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showPaywall) { PaywallView() }
            .confirmationDialog("Delete your account and all documents?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) {
                    Task {
                        do { try await account.deleteAccount() }
                        catch { deleteError = "We couldn't delete your account. Please try again or contact support." }
                    }
                }
            }
        }
    }
}
