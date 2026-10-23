import SwiftUI
import Observation
import PassKit

@MainActor
@Observable
final class ReservationDetailModel {
    let token: String

    private(set) var detail: ReservationDetail?
    private(set) var loadError: String?
    private(set) var lastUpdated: Date?
    private(set) var isCancelling = false
    private(set) var actionError: String?
    private(set) var walletLoadingSeq: Int?
    var presentedPass: PresentedPass?

    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(token: String) {
        self.token = token
    }

    var isStale: Bool { loadError != nil && detail != nil }

    private var basePath: String { "/public/reservations/by-token/\(APIPath.segment(token))" }

    func load() async {
        do {
            let loaded: ReservationDetail = try await APIClient.shared.get(basePath)
            apply(loaded)
            loadError = nil
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }

    func cancel() async {
        isCancelling = true
        actionError = nil
        defer { isCancelling = false }
        do {
            let updated: ReservationDetail = try await APIClient.shared.post("\(basePath)/cancel")
            apply(updated)
        } catch {
            actionError = error.userMessage
            await load()
        }
    }

    /// サーバーから .pkpass を取得して Wallet 追加画面を出す
    func addToWallet(ticket: ReservationDetail.Ticket) async {
        guard PKAddPassesViewController.canAddPasses() else {
            actionError = "この端末では Apple Wallet にチケットを追加できません。QRコードで入場できます"
            return
        }
        walletLoadingSeq = ticket.seq
        actionError = nil
        defer { walletLoadingSeq = nil }
        do {
            let data = try await APIClient.shared.rawData("\(basePath)/tickets/\(ticket.seq)/wallet",
                                                          accept: "application/vnd.apple.pkpass")
            let pass = try PKPass(data: data)
            presentedPass = PresentedPass(pass: pass)
        } catch let error as APIError {
            actionError = error.message
        } catch {
            actionError = "Walletパスを読み込めませんでした。QRコードで入場できます"
        }
    }

    func start() {
        guard sse == nil else { return }
        let client = SSEClient(topics: ["screenings"]) { [weak self] _ in
            self?.scheduleRefresh()
        }
        sse = client
        client.start()
    }

    func stop() {
        sse?.stop()
        sse = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    private func apply(_ loaded: ReservationDetail) {
        // 取消応答には wallet_enabled が含まれないため、直前の値を引き継ぐ
        if loaded.walletEnabled == nil, let previous = detail?.walletEnabled {
            detail = ReservationDetail(
                id: loaded.id, reservationNo: loaded.reservationNo, kind: loaded.kind, name: loaded.name,
                partySize: loaded.partySize, status: loaded.status, cancelReason: loaded.cancelReason,
                createdAt: loaded.createdAt, cancelledAt: loaded.cancelledAt, screening: loaded.screening,
                tickets: loaded.tickets, coupons: loaded.coupons, walletEnabled: previous)
        } else {
            detail = loaded
        }
        lastUpdated = Date()
        let store = TokenStore.shared
        store.upsert(reservation: SavedReservation(token: token, reservationNo: loaded.reservationNo,
                                                   title: loaded.screening.title, startsAt: loaded.screening.startsAt,
                                                   savedAt: Date()))
        // 鑑賞後に自動発券されたクーポンも端末に保存する
        for coupon in loaded.coupons {
            guard let couponToken = coupon.token else { continue }
            store.upsert(coupon: SavedCoupon(token: couponToken, couponNo: coupon.couponNo,
                                             name: coupon.name ?? "クーポン", savedAt: Date()))
        }
    }
}

/// 予約確認・チケット（QR）表示・取消・Wallet追加
struct ReservationDetailView: View {
    @State private var model: ReservationDetailModel
    @State private var showCancelConfirm = false

    init(token: String) {
        _model = State(initialValue: ReservationDetailModel(token: token))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let detail = model.detail {
                    header(detail)
                    if let error = model.actionError {
                        ErrorMessageView(message: error)
                    }
                    tickets(detail)
                    if !detail.coupons.isEmpty {
                        coupons(detail)
                    }
                    if detail.isConfirmed && !detail.hasAdmittedTicket && detail.screening.runStatus == "scheduled" {
                        cancelSection
                    }
                } else if let error = model.loadError {
                    ErrorMessageView(message: error) { Task { await model.load() } }
                } else {
                    ProgressView("予約を読み込み中…")
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
                FreshnessFooter(lastUpdated: model.lastUpdated, isStale: model.isStale)
                    .frame(maxWidth: .infinity)
            }
            .padding()
        }
        .navigationTitle("予約の確認")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        .sheet(item: $model.presentedPass) { presented in
            AddPassesSheet(pass: presented.pass)
                .ignoresSafeArea()
        }
        .confirmationDialog("この予約を取り消しますか？", isPresented: $showCancelConfirm, titleVisibility: .visible) {
            Button("予約を取り消す", role: .destructive) {
                Task { await model.cancel() }
            }
            Button("やめる", role: .cancel) {}
        } message: {
            Text("取り消すと席が解放され、元に戻せません。全員分のチケットが無効になります。")
        }
    }

    private func header(_ detail: ReservationDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            StatusBadge(text: detail.statusLabel,
                        systemImage: detail.isConfirmed ? "checkmark.seal" : "xmark.circle",
                        tint: detail.isConfirmed ? .green : .red)
            Text(detail.screening.title)
                .font(.title2.weight(.bold))
            Text("\(Fmt.day(detail.screening.startsAt)) \(Fmt.timeRange(detail.screening.startsAt, detail.screening.endsAt))")
                .font(.title3.monospacedDigit())
            HStack {
                Text("受付番号")
                    .foregroundStyle(.secondary)
                Text(detail.reservationNo)
                    .font(.headline.monospacedDigit())
            }
            Text("\(detail.name) 様・\(detail.partySize)人")
            if detail.screening.runStatus == "cancelled" {
                Label("この上映は中止になりました。\(detail.screening.cancelReason ?? "")", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
                    .font(.headline)
            }
            if !detail.isConfirmed, let reason = detail.cancelReason, !reason.isEmpty {
                Text("取消理由：\(reason)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func tickets(_ detail: ReservationDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("入場チケット")
                .font(.title3.weight(.bold))
            Text("入口でスタッフにQRコードを見せてください。1人につき1枚です。")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(detail.tickets) { ticket in
                TicketCard(
                    ticket: ticket,
                    usable: detail.isConfirmed && detail.screening.runStatus != "cancelled",
                    walletEnabled: detail.walletEnabled == true,
                    isLoadingWallet: model.walletLoadingSeq == ticket.seq
                ) {
                    Task { await model.addToWallet(ticket: ticket) }
                }
            }
        }
    }

    private func coupons(_ detail: ReservationDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("クーポン")
                .font(.title3.weight(.bold))
            ForEach(detail.coupons) { coupon in
                if let token = coupon.token {
                    NavigationLink {
                        CouponDetailView(token: token)
                    } label: {
                        HStack {
                            Image(systemName: "tag")
                            VStack(alignment: .leading) {
                                Text(coupon.name ?? "クーポン")
                                    .font(.headline)
                                Text("残り \(coupon.personsRemaining) / \(coupon.personsTotal) 人分・\(CouponStatus.label(coupon.status))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.secondary)
                        }
                        .padding()
                        .frame(minHeight: 44)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var cancelSection: some View {
        VStack(spacing: 6) {
            Button(role: .destructive) {
                showCancelConfirm = true
            } label: {
                if model.isCancelling {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 44)
                } else {
                    LargeButtonLabel(title: "予約を取り消す", systemImage: "xmark.circle")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(model.isCancelling)
            Text("入場後や締切後は取り消せません。会場のスタッフにお申し出ください。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct TicketCard: View {
    let ticket: ReservationDetail.Ticket
    let usable: Bool
    let walletEnabled: Bool
    let isLoadingWallet: Bool
    let onAddToWallet: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("チケット \(ticket.ticketNo)")
                    .font(.headline.monospacedDigit())
                Spacer()
                statusBadge
            }
            if usable && !ticket.isVoid, let entryToken = ticket.entryToken {
                QRCodeView(value: entryToken, label: "入場用QRコード、チケット番号 \(ticket.ticketNo)")
                    .frame(maxWidth: 280)
                if walletEnabled && !ticket.isAdmitted {
                    if isLoadingWallet {
                        ProgressView("Walletパスを準備中…")
                            .frame(minHeight: 50)
                    } else {
                        AddToWalletButton(action: onAddToWallet)
                            .frame(height: 50)
                            .frame(maxWidth: 320)
                            .accessibilityLabel("Apple Walletに追加")
                    }
                }
            } else {
                Text("このチケットは利用できません")
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private var statusBadge: some View {
        if ticket.isAdmitted {
            StatusBadge(text: "入場済み", systemImage: "checkmark.circle.fill", tint: .blue)
        } else if ticket.isVoid || !usable {
            StatusBadge(text: "無効", systemImage: "xmark.circle", tint: .red)
        } else {
            StatusBadge(text: "未入場", systemImage: "ticket", tint: .green)
        }
    }
}
