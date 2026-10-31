import SwiftUI

/// Shown once before any text leaves the device (Guideline 5.1.2(i)).
struct AIConsentView: View {
    var onAgree: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Before you start").font(.title.bold())
            Text("To suggest rewrites, Quill sends the text you choose to our server, which passes it to OpenAI, a third-party AI provider. OpenAI processes it to generate a suggestion and does not use it to train its models.")
            Text("We do not send your contacts, photos or location. You can withdraw consent at any time in Settings, which turns AI suggestions off.")
                .foregroundStyle(.secondary)
            Button("Read our Privacy Policy") {
                openURL(URL(string: "https://quillwriter.app/privacy")!)
            }
            Spacer()
            Button("I agree, share my text with OpenAI", action: onAgree)
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
        }
        .padding(24)
    }
}
