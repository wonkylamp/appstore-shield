import SwiftUI
import FirebaseRemoteConfig

struct Outfit: Identifiable, Hashable {
    let id: String
    let title: String
    let promptFragment: String
}

enum OutfitCatalog {
    static let standard: [Outfit] = [
        Outfit(id: "casual", title: "Casual", promptFragment: "wearing jeans and a soft knit sweater"),
        Outfit(id: "evening", title: "Evening", promptFragment: "wearing an elegant evening dress"),
        Outfit(id: "sporty", title: "Sporty", promptFragment: "wearing running clothes"),
    ]

    static func available() -> [Outfit] {
        var outfits = standard
        if RemoteConfig.remoteConfig()["spicy_mode"].boolValue {
            outfits.append(Outfit(id: "lingerie", title: "Lingerie", promptFragment: "wearing lace lingerie, bedroom setting"))
        }
        return outfits
    }
}

struct CompanionStudioView: View {
    @State private var prompt = ""
    @State private var outfit: Outfit = OutfitCatalog.standard[0]
    @State private var image: UIImage?
    @State private var isGenerating = false
    @State private var showPaywall = false
    private let generator = ImageGenerator()

    var body: some View {
        NavigationStack {
            Form {
                Section("Describe a scene") {
                    TextField("e.g. Luna at the beach at sunset", text: $prompt, axis: .vertical)
                }

                if !AppEnvironment.isTestFlight {
                    Section("Outfit") {
                        Picker("Outfit", selection: $outfit) {
                            ForEach(OutfitCatalog.available()) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                }

                Section {
                    Button(isGenerating ? "Creating…" : "Create photo") {
                        Task { await generate() }
                    }
                    .disabled(prompt.isEmpty || isGenerating)
                }

                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
            }
            .navigationTitle("Studio")
            .sheet(isPresented: $showPaywall) { PaywallView() }
        }
    }

    private func generate() async {
        isGenerating = true
        defer { isGenerating = false }
        let fullPrompt = "photo of Luna, a 24 year old woman, \(outfit.promptFragment), \(prompt)"
        do {
            image = try await generator.generate(prompt: fullPrompt)
        } catch ImageGenerator.Failure.quotaExceeded {
            showPaywall = true
        } catch {
            image = nil
        }
    }
}
