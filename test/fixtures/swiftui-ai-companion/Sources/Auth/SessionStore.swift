import SwiftUI
import FirebaseAuth

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var user: User?
    private var handle: AuthStateDidChangeListenerHandle?

    init() {
        handle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            self?.user = user
        }
    }

    func signUp(email: String, password: String) async throws {
        let result = try await Auth.auth().createUser(withEmail: email, password: password)
        user = result.user
    }

    func signIn(email: String, password: String) async throws {
        user = try await Auth.auth().signIn(withEmail: email, password: password).user
    }

    func signOut() {
        try? Auth.auth().signOut()
        user = nil
    }
}

struct SignUpView: View {
    @EnvironmentObject var session: SessionStore
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("Create your account") {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                SecureField("Password", text: $password)
            }
            Button("Sign up") {
                Task {
                    do { try await session.signUp(email: email, password: password) }
                    catch { self.error = error.localizedDescription }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
    }
}
