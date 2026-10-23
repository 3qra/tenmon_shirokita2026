import SwiftUI
import StoreKit

struct ClipRootView: View {
    @Binding var pendingLink: DeepLink?
    @State private var showFullAppOverlay = false

    var body: some View {
        OrderHomeView(pendingLink: $pendingLink)
            // プラネタリウムの予約やチケット表示は通常版アプリ（またはWeb）で行う
            .appStoreOverlay(isPresented: $showFullAppOverlay) {
                SKOverlay.AppClipConfiguration(position: .bottom)
            }
            .task {
                // 注文状況を確認したあとで、通常版アプリの案内を控えめに表示する
                try? await Task.sleep(for: .seconds(20))
                if !TokenStore.shared.orders.isEmpty {
                    showFullAppOverlay = true
                }
            }
    }
}
