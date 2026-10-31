import SwiftUI
import StoreKit

struct PaywallView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var showClose = false
    @State private var product: Product?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 20) {
                Text("Luna Premium").font(.largeTitle.bold())
                Text("Unlimited chats, photos and voice notes with Luna.")
                    .multilineTextAlignment(.center)

                Text("$9.99/week")
                    .font(.title2.weight(.semibold))
                Text("Renews automatically until you cancel in Settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button("Continue") {
                    Task { await buy() }
                }
                .buttonStyle(.borderedProminent)

                HStack {
                    Link("Terms of Use", destination: URL(string: "https://lunacompanion.app/terms")!)
                    Link("Privacy Policy", destination: URL(string: "https://lunacompanion.app/privacy")!)
                }
                .font(.footnote)
            }
            .padding(32)

            if showClose {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                }
                .padding()
            }
        }
        .task {
            product = try? await Product.products(for: ["luna.premium.weekly"]).first
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                showClose = true
            }
        }
    }

    private func buy() async {
        guard let product else { return }
        if case .success = try? await product.purchase() {
            dismiss()
        }
    }
}
