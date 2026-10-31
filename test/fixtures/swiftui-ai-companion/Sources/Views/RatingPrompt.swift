import SwiftUI
import StoreKit

struct RatingPrompt: ViewModifier {
    @Binding var isPresented: Bool
    @Environment(\.requestReview) private var requestReview
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content.alert("Enjoying the app?", isPresented: $isPresented) {
            Button("Yes, I love it!") {
                requestReview()
            }
            Button("Not really", role: .cancel) {
                openURL(URL(string: "mailto:feedback@lunacompanion.app?subject=Feedback")!)
            }
        } message: {
            Text("Tell us how Luna is doing.")
        }
    }
}
