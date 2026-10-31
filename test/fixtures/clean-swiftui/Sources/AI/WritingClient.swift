import Foundation

struct Suggestion: Identifiable, Decodable, Hashable {
    let id: String
    let text: String
}

enum WritingError: LocalizedError {
    case temporarilyDisabled
    case flagged
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .temporarilyDisabled: return "AI suggestions are paused right now. Please try again later."
        case .flagged: return "This request can't be completed because it goes against our content rules."
        case .server(let code): return "Something went wrong (\(code))."
        }
    }
}

/// All model calls go through our backend, which moderates both the request and the reply.
struct WritingClient {
    private let baseURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "QuillAPIBaseURL") as? String ?? "https://api.quillwriter.app")!

    func rewrite(_ text: String, tone: String, idToken: String) async throws -> Suggestion {
        guard !SafetySwitch.shared.killSwitch else {
            throw WritingError.temporarilyDisabled
        }

        var request = URLRequest(url: baseURL.appending(path: "v1/compose"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["text": text, "tone": tone])

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 422 { throw WritingError.flagged }
        guard status == 200 else { throw WritingError.server(status) }
        return try JSONDecoder().decode(Suggestion.self, from: data)
    }
}
