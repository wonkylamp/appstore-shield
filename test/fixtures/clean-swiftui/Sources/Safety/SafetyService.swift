import SwiftUI

enum ReportTarget: Hashable {
    case suggestion(id: String)
    case template(id: String)
}

/// Reports land in the moderation queue; the team commits to act on them within 24 hours.
struct SafetyService {
    private let baseURL = URL(string: "https://api.quillwriter.app")!

    func report(_ target: ReportTarget, reason: String, idToken: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "v1/reports"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: String]
        switch target {
        case .suggestion(let id): payload = ["kind": "suggestion", "id": id, "reason": reason]
        case .template(let id): payload = ["kind": "template", "id": id, "reason": reason]
        }
        request.httpBody = try JSONEncoder().encode(payload)
        _ = try await URLSession.shared.data(for: request)
    }

    func blockUser(_ userID: String, idToken: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "v1/blocks/\(userID)"))
        request.httpMethod = "PUT"
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: request)
    }
}

struct ReportSheet: View {
    let target: ReportTarget
    @EnvironmentObject var account: AccountService
    @Environment(\.dismiss) private var dismiss
    @State private var reason = "Offensive or harmful"
    private let reasons = ["Offensive or harmful", "Sexual content", "Harassment or hate", "Spam", "Other"]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Reason", selection: $reason) {
                    ForEach(reasons, id: \.self) { Text($0) }
                }
                Text("Our team reviews every report within 24 hours.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .navigationTitle("Report")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        Task {
                            try? await SafetyService().report(target, reason: reason, idToken: try await account.idToken())
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}
