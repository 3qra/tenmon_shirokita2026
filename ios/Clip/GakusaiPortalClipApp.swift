import SwiftUI

/// App Clip：来場者のモバイル注文。
/// 呼び出しURL https://<domain>/order/<部門ID> から起動し、該当部門のメニューを開く。
/// App Clip 非対応の端末では同じURLが Web の注文画面として開く（README 参照）。
@main
struct GakusaiPortalClipApp: App {
    @State private var pendingLink: DeepLink?

    var body: some Scene {
        WindowGroup {
            ClipRootView(pendingLink: $pendingLink)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let url = activity.webpageURL else { return }
                    pendingLink = DeepLink.parse(url)
                }
                .onOpenURL { url in
                    pendingLink = DeepLink.parse(url)
                }
        }
    }
}
