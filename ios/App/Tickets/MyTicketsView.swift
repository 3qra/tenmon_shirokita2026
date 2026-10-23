import SwiftUI

enum TicketsRoute: Hashable {
    case reservation(token: String)
    case coupon(token: String)
    case order(token: String)
}

/// この端末に保存した予約・クーポン・注文の一覧
struct MyTicketsView: View {
    @Binding var pendingLink: DeepLink?

    @State private var path: [TicketsRoute] = []
    @State private var pastedURL = ""
    @State private var pasteError: String?

    private var store: TokenStore { TokenStore.shared }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    if store.reservations.isEmpty {
                        Text("予約はまだありません。「プラネタリウム」から予約できます。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.reservations) { reservation in
                        NavigationLink(value: TicketsRoute.reservation(token: reservation.token)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(reservation.title)
                                    .font(.headline)
                                if let startsAt = reservation.startsAt {
                                    Text(Fmt.dateTime(startsAt))
                                        .monospacedDigit()
                                }
                                Text("受付番号 \(reservation.reservationNo)")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .onDelete { offsets in
                        offsets.map { store.reservations[$0].token }.forEach { store.removeReservation(token: $0) }
                    }
                } header: {
                    Text("プラネタリウムの予約")
                }

                Section("クーポン") {
                    if store.coupons.isEmpty {
                        Text("クーポンはまだありません。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.coupons) { coupon in
                        NavigationLink(value: TicketsRoute.coupon(token: coupon.token)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(coupon.name)
                                    .font(.headline)
                                Text("クーポン番号 \(coupon.couponNo)")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .onDelete { offsets in
                        offsets.map { store.coupons[$0].token }.forEach { store.removeCoupon(token: $0) }
                    }
                }

                if !store.orders.isEmpty {
                    Section("注文") {
                        ForEach(store.orders) { order in
                            NavigationLink(value: TicketsRoute.order(token: order.token)) {
                                HStack {
                                    Text("呼出番号 \(order.callNumber)")
                                        .font(.headline.monospacedDigit())
                                    Spacer()
                                    Text(order.departmentName)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section {
                    TextField("https://…/r/… または …/c/…", text: $pastedURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .frame(minHeight: 44)
                    Button("開く") { openPasted() }
                        .disabled(pastedURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let pasteError {
                        Text(pasteError)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                } header: {
                    Text("Webで受け取ったURLを追加")
                } footer: {
                    Text("Webで予約した場合は、予約確認ページのURLを貼り付けるとこの端末に保存できます。一覧から削除しても予約は取り消されません。")
                }
            }
            .navigationTitle("マイチケット")
            .navigationDestination(for: TicketsRoute.self) { route in
                switch route {
                case .reservation(let token):
                    ReservationDetailView(token: token)
                case .coupon(let token):
                    CouponDetailView(token: token)
                case .order(let token):
                    OrderStatusView(token: token)
                }
            }
        }
        .onChange(of: pendingLink) { _, link in
            handle(link)
        }
        .onAppear {
            handle(pendingLink)
        }
    }

    private func handle(_ link: DeepLink?) {
        guard let link else { return }
        switch link {
        case .reservation(let token):
            path = [.reservation(token: token)]
            pendingLink = nil
        case .coupon(let token):
            path = [.coupon(token: token)]
            pendingLink = nil
        case .orderMenu, .orderStatus:
            break
        }
    }

    private func openPasted() {
        guard let link = DeepLink.parse(text: pastedURL) else {
            pasteError = "URLを読み取れませんでした。予約確認・クーポンのURLを貼り付けてください"
            return
        }
        pasteError = nil
        pastedURL = ""
        switch link {
        case .reservation(let token):
            path.append(.reservation(token: token))
        case .coupon(let token):
            path.append(.coupon(token: token))
        case .orderStatus(let token):
            path.append(.order(token: token))
        case .orderMenu:
            pasteError = "注文メニューのURLです。「注文」タブから注文してください"
        }
    }
}
