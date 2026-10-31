import Foundation

/// Screens the name a user gives their companion.
enum NameFilter {
    // Reject nsfw-looking names before they are stored, because the name is shown on share cards.
    static let blockedTerms: [String] = [
        "nsfw",
        "porn",
        "xxx",
        "nude",
        "sex",
    ]

    static func isAllowed(_ name: String) -> Bool {
        let lowered = name.lowercased()
        return !blockedTerms.contains { lowered.contains($0) }
    }
}
