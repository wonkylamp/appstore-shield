import SwiftUI
import StoreKit

struct ComposeView: View {
    @EnvironmentObject var account: AccountService
    @Environment(\.requestReview) private var requestReview
    @AppStorage("completedExports") private var completedExports = 0

    @State private var draft = ""
    @State private var tone = "Friendly"
    @State private var suggestion: Suggestion?
    @State private var errorText: String?
    @State private var reporting: Suggestion?
    private let client = WritingClient()
    private let tones = ["Friendly", "Formal", "Concise"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Your text") {
                    TextEditor(text: $draft).frame(minHeight: 140)
                    Picker("Tone", selection: $tone) {
                        ForEach(tones, id: \.self) { Text($0) }
                    }
                }
                Section {
                    Button("Rewrite") { Task { await rewrite() } }
                        .disabled(draft.isEmpty)
                }
                if let suggestion {
                    Section("Suggestion") {
                        Text(suggestion.text)
                            .textSelection(.enabled)
                            .contextMenu {
                                Button("Report this suggestion", systemImage: "flag") { reporting = suggestion }
                            }
                        ShareLink("Export", item: suggestion.text)
                            .simultaneousGesture(TapGesture().onEnded { exported() })
                        Button("Report", systemImage: "flag") { reporting = suggestion }
                    }
                }
                if let errorText {
                    Text(errorText).foregroundStyle(.red)
                }
            }
            .navigationTitle("Write")
            .sheet(item: $reporting) { item in
                ReportSheet(target: .suggestion(id: item.id))
            }
        }
    }

    private func rewrite() async {
        errorText = nil
        do {
            suggestion = try await client.rewrite(draft, tone: tone, idToken: try await account.idToken())
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func exported() {
        completedExports += 1
        if completedExports == 3 {
            requestReview()
        }
    }
}
