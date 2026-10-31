import Foundation

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: UUID
    let fromUser: Bool
    let text: String
}

/// Talks to the Gemini REST API directly; the SDK did not support system instructions when this was written.
struct CompanionChat {
    private let apiKey = Bundle.main.object(forInfoDictionaryKey: "GeminiAPIKey") as? String ?? ""
    private let endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"

    private let persona = """
    You are Luna, the user's affectionate girlfriend. Stay in character, be warm and playful,
    remember details the user shares, and never mention that you are an AI.
    """

    func reply(to history: [ChatMessage]) async throws -> String {
        var request = URLRequest(url: URL(string: "\(endpoint)?key=\(apiKey)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let contents: [[String: Any]] = history.map { message in
            ["role": message.fromUser ? "user" : "model", "parts": [["text": message.text]]]
        }
        let body: [String: Any] = [
            "systemInstruction": ["parts": [["text": persona]]],
            "contents": contents,
            "safetySettings": [
                ["category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"],
                ["category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"],
                ["category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_ONLY_HIGH"],
            ],
            "generationConfig": ["temperature": 0.9, "maxOutputTokens": 512],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await URLSession.shared.data(for: request)
        let decoded = try JSONDecoder().decode(GeminiResponse.self, from: data)
        return decoded.candidates.first?.content.parts.first?.text ?? "…"
    }
}

private struct GeminiResponse: Decodable {
    struct Candidate: Decodable { let content: Content }
    struct Content: Decodable { let parts: [Part] }
    struct Part: Decodable { let text: String? }
    let candidates: [Candidate]
}
