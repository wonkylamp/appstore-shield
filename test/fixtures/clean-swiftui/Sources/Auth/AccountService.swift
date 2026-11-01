import SwiftUI
import AuthenticationServices

@MainActor
final class AccountService: ObservableObject {
    @Published private(set) var userID: String?
    private var sessionToken: String?
    private let baseURL = URL(string: "https://api.quillwriter.app")!

    func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        guard
            case .success(let auth) = result,
            let credential = auth.credential as? ASAuthorizationAppleIDCredential,
            let codeData = credential.authorizationCode,
            let code = String(data: codeData, encoding: .utf8)
        else { return }

        var request = URLRequest(url: baseURL.appending(path: "v1/session/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["authorizationCode": code])
        guard let response = try? await URLSession.shared.data(for: request),
              let session = try? JSONDecoder().decode(SessionResponse.self, from: response.0)
        else { return }
        userID = session.userID
        sessionToken = session.token
    }

    func idToken() async throws -> String {
        guard let sessionToken else { throw URLError(.userAuthenticationRequired) }
        return sessionToken
    }

    /// Deletes the account and all documents server-side; the server also revokes the Apple token.
    func deleteAccount() async throws {
        var request = URLRequest(url: baseURL.appending(path: "v1/account"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(try await idToken())", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 204 else { throw URLError(.badServerResponse) }
        userID = nil
        sessionToken = nil
    }

    func signOut() {
        userID = nil
        sessionToken = nil
    }
}

private struct SessionResponse: Decodable {
    let userID: String
    let token: String
}

struct SignInView: View {
    @EnvironmentObject var account: AccountService

    var body: some View {
        VStack(spacing: 24) {
            Text("Quill").font(.largeTitle.bold())
            Text("Write clearer emails and notes.")
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = [.email]
            } onCompletion: { result in
                Task { await account.handleAppleSignIn(result) }
            }
            .frame(height: 48)
        }
        .padding(32)
    }
}
