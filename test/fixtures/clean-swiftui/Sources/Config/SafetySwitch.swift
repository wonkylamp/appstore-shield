import Foundation
import FirebaseRemoteConfig

/// A server-side brake: it can only turn AI generation off (for an outage or abuse wave), never unlock anything.
final class SafetySwitch {
    static let shared = SafetySwitch()
    private let remoteConfig = RemoteConfig.remoteConfig()

    private init() {
        remoteConfig.setDefaults(["generation_killswitch": false as NSObject])
    }

    func refresh() {
        remoteConfig.fetchAndActivate { _, _ in }
    }

    var killSwitch: Bool {
        remoteConfig["generation_killswitch"].boolValue
    }
}
