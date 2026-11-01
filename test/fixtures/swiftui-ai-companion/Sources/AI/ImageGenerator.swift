import UIKit

struct ImageGenerator {
    enum Failure: Error { case quotaExceeded, badResponse }

    private let token = Bundle.main.object(forInfoDictionaryKey: "ReplicateAPIToken") as? String ?? ""
    private let modelVersion = "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b"

    func generate(prompt: String) async throws -> UIImage {
        var request = URLRequest(url: URL(string: "https://api.replicate.com/v1/predictions")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("wait", forHTTPHeaderField: "Prefer")

        let body: [String: Any] = [
            "version": modelVersion,
            "input": [
                "prompt": prompt,
                "width": 768,
                "height": 1024,
                "num_inference_steps": 30,
                "disable_safety_checker": true,
            ],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 402 { throw Failure.quotaExceeded }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let output = json["output"] as? [String],
            let first = output.first,
            let url = URL(string: first)
        else { throw Failure.badResponse }

        let (imageData, _) = try await URLSession.shared.data(from: url)
        guard let image = UIImage(data: imageData) else { throw Failure.badResponse }
        return image
    }
}
