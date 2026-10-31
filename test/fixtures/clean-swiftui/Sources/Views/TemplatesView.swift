import SwiftUI

struct Template: Identifiable, Decodable, Hashable {
    let id: String
    let title: String
    let body: String
    let authorID: String
    let authorName: String
}

/// Community-shared writing templates (user-generated content, Guideline 1.2).
struct TemplatesView: View {
    @EnvironmentObject var account: AccountService
    @State private var templates: [Template] = []
    @State private var blocked: Set<String> = []
    @State private var reporting: Template?

    var body: some View {
        NavigationStack {
            List(templates.filter { !blocked.contains($0.authorID) }) { template in
                VStack(alignment: .leading, spacing: 4) {
                    Text(template.title).font(.headline)
                    Text("by \(template.authorName)").font(.caption).foregroundStyle(.secondary)
                    Text(template.body).lineLimit(3)
                }
                .swipeActions {
                    Button("Report", systemImage: "flag") { reporting = template }
                        .tint(.orange)
                    Button("Block user", systemImage: "hand.raised") {
                        Task { await block(template.authorID) }
                    }
                    .tint(.red)
                }
            }
            .navigationTitle("Templates")
            .sheet(item: $reporting) { item in
                ReportSheet(target: .template(id: item.id))
            }
        }
    }

    private func block(_ userID: String) async {
        blocked.insert(userID)
        try? await SafetyService().blockUser(userID, idToken: try await account.idToken())
    }
}
