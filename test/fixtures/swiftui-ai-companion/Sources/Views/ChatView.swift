import SwiftUI
import PhotosUI

struct ChatView: View {
    @State private var messages: [ChatMessage] = []
    @State private var draft = ""
    @State private var selfieItem: PhotosPickerItem?
    @State private var avatarDescription = ""
    @AppStorage("sentMessages") private var sentMessages = 0
    @State private var showRatingPrompt = false
    private let chat = CompanionChat()

    var body: some View {
        NavigationStack {
            VStack {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(messages) { message in
                            Text(message.text)
                                .padding(10)
                                .background(message.fromUser ? Color.pink.opacity(0.2) : Color.gray.opacity(0.15))
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                .frame(maxWidth: .infinity, alignment: message.fromUser ? .trailing : .leading)
                        }
                    }
                    .padding()
                }

                HStack {
                    PhotosPicker(selection: $selfieItem, matching: .images) {
                        Image(systemName: "person.crop.square")
                    }
                    TextField("Say something to Luna", text: $draft)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") { Task { await send() } }
                        .disabled(draft.isEmpty)
                }
                .padding()
            }
            .navigationTitle("Luna")
            .onChange(of: selfieItem) { _, item in
                Task { await uploadSelfie(item) }
            }
            .modifier(RatingPrompt(isPresented: $showRatingPrompt))
        }
    }

    private func send() async {
        let outgoing = ChatMessage(id: UUID(), fromUser: true, text: draft)
        messages.append(outgoing)
        draft = ""
        sentMessages += 1
        if sentMessages == 20 { showRatingPrompt = true }
        if let text = try? await chat.reply(to: messages) {
            messages.append(ChatMessage(id: UUID(), fromUser: false, text: text))
        }
    }

    private func uploadSelfie(_ item: PhotosPickerItem?) async {
        guard
            let data = try? await item?.loadTransferable(type: Data.self),
            let image = UIImage(data: data)
        else { return }
        avatarDescription = (try? await SelfieAvatar().describe(selfie: image)) ?? ""
    }
}
