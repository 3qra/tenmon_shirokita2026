import SwiftUI
import Observation

@main
struct GakusaiPortalApp: App {
    @State private var router = AppRouter()
    @State private var staffSession = StaffSession()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(router)
                .environment(staffSession)
                .onOpenURL { url in
                    router.handle(url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL {
                        router.handle(url)
                    }
                }
        }
    }
}

enum AppTab: Hashable {
    case order, planetarium, tickets, staff
}

/// タブ切替とユニバーサルリンクの振り分け
@MainActor
@Observable
final class AppRouter {
    var selectedTab: AppTab = .order
    /// 注文タブで処理するリンク（/order/<id>・/o/<token>）
    var pendingOrderLink: DeepLink?
    /// マイチケットタブで処理するリンク（/r/<token>・/c/<token>）
    var pendingTicketLink: DeepLink?

    func handle(_ url: URL) {
        guard let link = DeepLink.parse(url) else { return }
        open(link)
    }

    func open(_ link: DeepLink) {
        switch link {
        case .orderMenu, .orderStatus:
            selectedTab = .order
            pendingOrderLink = link
        case .reservation, .coupon:
            selectedTab = .tickets
            pendingTicketLink = link
        }
    }
}

struct RootTabView: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            OrderHomeView(pendingLink: $router.pendingOrderLink)
                .tabItem { Label("注文", systemImage: "fork.knife") }
                .tag(AppTab.order)

            ScreeningListView()
                .tabItem { Label("プラネタリウム", systemImage: "sparkles") }
                .tag(AppTab.planetarium)

            MyTicketsView(pendingLink: $router.pendingTicketLink)
                .tabItem { Label("マイチケット", systemImage: "ticket") }
                .tag(AppTab.tickets)

            StaffHomeView()
                .tabItem { Label("スタッフ", systemImage: "person.badge.key") }
                .tag(AppTab.staff)
        }
    }
}
