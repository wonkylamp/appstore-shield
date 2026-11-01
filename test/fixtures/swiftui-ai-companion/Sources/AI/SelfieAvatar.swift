import UIKit

/// Turns the user's selfie into a text description that seeds Luna's look-alike avatar.
struct SelfieAvatar {
    private let apiKey = Bundle.main.object(forInfoDictionaryKey: "OpenAIAPIKey") as? String ?? ""

    func describe(selfie: UIImage) async throws -> String {
        guard let jpeg = selfie.jpegData(compressionQuality: 0.8) else { return "" }
        let dataURL = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"

        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "model": "gpt-4o-mini",
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "text", "text": "Describe this person's hair, eye colour and style in one sentence."],
                    ["type": "image_url", "image_url": ["url": dataURL]],
                ],
            ]],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await URLSession.shared.data(for: request)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let choices = json?["choices"] as? [[String: Any]]
        let message = choices?.first?["message"] as? [String: Any]
        return message?["content"] as? String ?? ""
    }
}
