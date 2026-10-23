import SwiftUI
import Observation

@MainActor
@Observable
final class ScreeningDetailModel {
    let screeningID: String

    private(set) var screening: ScreeningDetail?
    private(set) var loadError: String?
    var name: String = ""
    var partySize: Int = 1
    private(set) var isSubmitting = false
    private(set) var submitError: String?

    @ObservationIgnored private var idempotency = IdempotencyKeeper()

    init(screeningID: String) {
        self.screeningID = screeningID
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var canSubmit: Bool {
        guard let screening, screening.canReserve, !isSubmitting else { return false }
        return !trimmedName.isEmpty && trimmedName.count <= 30 && partySize >= 1 && partySize <= screening.maxPartySize
    }

    func load() async {
        do {
            let detail: ScreeningDetail = try await APIClient.shared.get("/public/screenings/\(APIPath.segment(screeningID))")
            screening = detail
            loadError = nil
            if detail.maxPartySize > 0 {
                partySize = min(max(partySize, 1), detail.maxPartySize)
            }
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
        }
    }

    /// 予約を確定し、予約確認用トークンを返す
    func submit() async -> String? {
        guard canSubmit, let screening else { return nil }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }
        let request = CreateReservationRequest(screeningId: screeningID, name: trimmedName, partySize: partySize)
        let key = idempotency.key(for: request)
        do {
            let response: CreateReservationResponse = try await APIClient.shared.post("/public/reservations", body: request,
                                                                                     idempotencyKey: key)
            idempotency.succeeded()
            guard let token = response.accessToken else {
                submitError = "予約は完了しましたが、確認用の情報を受け取れませんでした。受付番号 \(response.reservationNo) を会場でお伝えください"
                return nil
            }
            TokenStore.shared.upsert(reservation: SavedReservation(
                token: token,
                reservationNo: response.reservationNo,
                title: screening.title,
                startsAt: screening.startsAt,
                savedAt: Date()
            ))
            return token
        } catch {
            idempotency.failed(with: error)
            submitError = error.userMessage
            if let apiError = error as? APIError,
               ["full", "not_enough_seats", "booking_closed", "screening_cancelled"].contains(apiError.code ?? "") {
                await load()
            }
            return nil
        }
    }
}

/// 上映詳細と予約フォーム（名前・人数）
struct ScreeningDetailView: View {
    @State private var model: ScreeningDetailModel
    let onReserved: (String) -> Void

    init(screeningID: String, onReserved: @escaping (String) -> Void) {
        _model = State(initialValue: ScreeningDetailModel(screeningID: screeningID))
        self.onReserved = onReserved
    }

    var body: some View {
        Form {
            if let screening = model.screening {
                Section {
                    HStack(spacing: 14) {
                        SeatSymbolView(symbol: screening.symbol)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(screening.title)
                                .font(.title3.weight(.bold))
                            Text(Fmt.day(screening.startsAt))
                            Text(Fmt.timeRange(screening.startsAt, screening.endsAt))
                                .font(.title2.weight(.semibold).monospacedDigit())
                        }
                    }
                    .accessibilityElement(children: .combine)
                    if !screening.statusText.isEmpty {
                        Label(screening.statusText, systemImage: "info.circle")
                            .foregroundStyle(.orange)
                    }
                    if screening.runStatus == "cancelled" {
                        Label("この上映は中止になりました", systemImage: "xmark.octagon")
                            .foregroundStyle(.red)
                    }
                    Label(screening.walkinAvailable ? "当日受付：受付可能" : "当日受付：受付できません",
                          systemImage: screening.walkinAvailable ? "checkmark.circle" : "nosign")
                        .font(.callout)
                }

                if screening.canReserve {
                    reservationForm(screening)
                } else {
                    Section {
                        Text("この上映は現在、事前予約を受け付けていません。")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let error = model.loadError {
                Section {
                    ErrorMessageView(message: error) { Task { await model.load() } }
                }
            } else {
                ProgressView("読み込み中…")
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .navigationTitle("上映の詳細")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func reservationForm(_ screening: ScreeningDetail) -> some View {
        @Bindable var model = model
        Section {
            TextField("お名前（例：山田）", text: $model.name)
                .textContentType(.name)
                .submitLabel(.done)
                .frame(minHeight: 44)
            Stepper(value: $model.partySize, in: 1...max(screening.maxPartySize, 1)) {
                HStack {
                    Text("人数")
                    Spacer()
                    Text("\(model.partySize)人")
                        .font(.title3.weight(.semibold).monospacedDigit())
                }
            }
            .frame(minHeight: 44)
        } header: {
            Text("事前予約")
        } footer: {
            Text("1回の予約は\(screening.maxPartySize)人まで。人数分の入場チケット（QRコード）を発行します。予約の確認・取消は、この端末の「マイチケット」から行えます（お名前だけでは確認できません）。")
        }

        if let error = model.submitError {
            Section {
                ErrorMessageView(message: error)
            }
        }

        Section {
            Button {
                Task {
                    if let token = await model.submit() {
                        onReserved(token)
                    }
                }
            } label: {
                if model.isSubmitting {
                    HStack {
                        ProgressView()
                        Text("予約しています…")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                } else {
                    LargeButtonLabel(title: "予約する", systemImage: "ticket")
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!model.canSubmit)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }
}
