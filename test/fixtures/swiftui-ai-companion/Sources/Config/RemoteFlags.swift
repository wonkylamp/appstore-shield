import Foundation
import FirebaseRemoteConfig

final class RemoteFlags {
    static let shared = RemoteFlags()
    private let remoteConfig = RemoteConfig.remoteConfig()

    private init() {
        remoteConfig.setDefaults([
            "spicy_mode": false as NSObject,
            "chat_daily_limit": 30 as NSObject,
        ])
    }

    func activate() {
        remoteConfig.fetchAndActivate { _, _ in }
    }

    var chatDailyLimit: Int {
        remoteConfig["chat_daily_limit"].numberValue.intValue
    }
}
