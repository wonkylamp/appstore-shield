import SwiftUI
import StoreKit

struct PaywallView: View {
    private let groupID = "21456789"

    var body: some View {
        SubscriptionStoreView(groupID: groupID) {
            VStack(spacing: 8) {
                Text("Quill Plus").font(.largeTitle.bold())
                Text("More rewrites each day, longer documents and custom tones.")
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
        .storeButton(.visible, for: .restorePurchases)
        .subscriptionStorePolicyDestination(url: URL(string: "https://quillwriter.app/terms")!, for: .termsOfService)
        .subscriptionStorePolicyDestination(url: URL(string: "https://quillwriter.app/privacy")!, for: .privacyPolicy)
    }
}
