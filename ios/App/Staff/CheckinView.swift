import SwiftUI
import Observation

/// 読み取り（照会）した入力。QRの検証用トークン、または手入力のチケット番号。
enum CheckinInput: Hashable {
    case token(String)
    case ticketNo(String)
}

@MainActor
@Observable
final class CheckinModel {
    let session: StaffSession

    private(set) var screenings: [StaffScreening] = []
    /// 照合する上映（nil なら上映違いの判定をしない）
    var selectedScreeningID: String?
    private(set) var result: CheckinResult?
    private(set) var input: CheckinInput?
    private(set) var isWorking = false
    private(set) var errorMessage: String?
    var manualTicketNo = ""

    @ObservationIgnored private var idempotency = IdempotencyKeeper()

    init(session: StaffSession) {
        self.session = session
    }

    var isShowingResult: Bool { result != nil || errorMessage != nil }

    func loadScreenings() async {
        guard let token = session.token else { return }
        do {
            let response: StaffScreeningsResponse = try await APIClient.shared.get("/staff/screenings", bearer: token)
            screenings = response.screenings.filter { $0.runStatus != "finished" }
        } catch let error where error.isCancellation {
            return
        } catch {
            errorMessage = session.message(for: error)
        }
    }

    private func request(for input: CheckinInput) -> CheckinRequest {
        switch input {
        case .token(let token):
            return CheckinRequest(token: token, ticketNo: nil, screeningId: selectedScreeningID)
        case .ticketNo(let number):
            return CheckinRequest(token: nil, ticketNo: number, screeningId: selectedScreeningID)
        }
    }

    /// 読み取った内容を照会する（入場はまだ確定しない）
    func verify(_ input: CheckinInput) async {
        guard let token = session.token, !isWorking else { return }
        self.input = input
        result = nil
        errorMessage = nil
        isWorking = true
        defer { isWorking = false }
        do {
            result = try await APIClient.shared.post("/staff/checkin/verify", body: request(for: input), bearer: token)
        } catch {
            errorMessage = session.message(for: error)
        }
    }

    /// 入場を確定する（Idempotency-Key 付き。同じチケットは一度だけ入場成立）
    func admit() async {
        guard let token = session.token, let input, !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        let body = request(for: input)
        let key = idempotency.key(for: body)
        do {
            let admitted: CheckinResult = try await APIClient.shared.post("/staff/checkin", body: body, bearer: token,
                                                                         idempotencyKey: key)
            idempotency.succeeded()
            result = admitted
        } catch {
            idempotency.failed(with: error)
            errorMessage = session.message(for: error)
        }
    }

    func reset() {
        result = nil
        input = nil
        errorMessage = nil
        manualTicketNo = ""
    }
}

/// 入場チェックイン：QR読み取り → 照会 → 入場確定。カメラが使えないときはチケット番号を手入力する。
struct CheckinView: View {
    @State private var model: CheckinModel

    init(session: StaffSession) {
        _model = State(initialValue: CheckinModel(session: session))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                screeningPicker

                if model.isShowingResult {
                    resultCard
                } else {
                    QRScannerPanel(isActive: !model.isWorking && !model.isShowingResult) { value in
                        Task { await model.verify(.token(ScannedValue.token(from: value))) }
                    }
                    if model.isWorking {
                        ProgressView("照会しています…")
                            .frame(maxWidth: .infinity)
                    }
                }

                manualEntry
            }
            .padding()
        }
        .navigationTitle("入場チェックイン")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadScreenings() }
        .sensoryFeedback(trigger: model.result?.result) { _, newValue in
            guard let newValue else { return nil }
            return ["admitted", "ok"].contains(newValue) ? .success : .error
        }
    }

    private var screeningPicker: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 4) {
            Picker("照合する上映", selection: $model.selectedScreeningID) {
                Text("上映を指定しない").tag(String?.none)
                ForEach(model.screenings) { screening in
                    Text("\(Fmt.time(screening.startsAt)) \(screening.title)（\(screening.admittedCount)/\(screening.capacity)人入場）")
                        .tag(Optional(screening.id))
                }
            }
            .pickerStyle(.menu)
            .frame(minHeight: 44)
            Text("上映を指定すると、別の回のチケットを「上映回違い」として判定します。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var resultCard: some View {
        VStack(spacing: 14) {
            if let result = model.result {
                let style = CheckinResultStyle(result: result.result)
                Image(systemName: style.systemImage)
                    .font(.system(size: 64))
                    .foregroundStyle(style.tint)
                    .accessibilityHidden(true)
                Text(style.title)
                    .font(.largeTitle.weight(.heavy))
                    .multilineTextAlignment(.center)
                Text(result.message)
                    .font(.title3)
                    .multilineTextAlignment(.center)
                if let ticket = result.ticket {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("チケット \(ticket.ticketNo)")
                            .font(.headline.monospacedDigit())
                        Text("\(Fmt.time(ticket.startsAt)) \(ticket.title)")
                        Text("受付番号 \(ticket.reservationNo)・\(ticket.name) 様・\(ticket.partySize)人")
                            .font(.callout)
                        if let admittedAt = ticket.admittedAt {
                            Text("入場時刻 \(Fmt.timeWithSeconds(admittedAt))")
                                .font(.callout)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
                if result.result == "ok" {
                    Button {
                        Task { await model.admit() }
                    } label: {
                        if model.isWorking {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 44)
                        } else {
                            LargeButtonLabel(title: "入場を確定する", systemImage: "checkmark.circle")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.isWorking)
                }
            }
            if let message = model.errorMessage {
                ErrorMessageView(message: message)
                if model.input != nil && model.result?.result == "ok" {
                    Text("通信が途切れた場合は「入場を確定する」をもう一度押してください（二重には入場しません）。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Button {
                model.reset()
            } label: {
                LargeButtonLabel(title: "次のチケットを読み取る", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(model.isWorking)
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
        .overlay(RoundedRectangle(cornerRadius: 16)
            .stroke(CheckinResultStyle(result: model.result?.result ?? "").tint, lineWidth: 3))
        .accessibilityElement(children: .contain)
    }

    private var manualEntry: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            Text("チケット番号で照会")
                .font(.headline)
            HStack {
                TextField("例：17-002-1", text: $model.manualTicketNo)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.numbersAndPunctuation)
                    .font(.title3.monospacedDigit())
                    .textFieldStyle(.roundedBorder)
                    .frame(minHeight: 44)
                Button("照会") {
                    let number = model.manualTicketNo.trimmingCharacters(in: .whitespaces)
                    guard !number.isEmpty else { return }
                    Task { await model.verify(.ticketNo(number)) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.manualTicketNo.trimmingCharacters(in: .whitespaces).isEmpty || model.isWorking)
            }
            Text("QRが読み取れない・カメラが使えないときは、チケットに表示された番号を入力してください。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// 照会・入場結果の表示（アイコン＋文字＋色。色だけに頼らない）
struct CheckinResultStyle {
    let title: String
    let systemImage: String
    let tint: Color

    init(result: String) {
        let style: (String, String, Color)
        switch result {
        case "ok":
            style = ("入場できます", "checkmark.circle", .blue)
        case "admitted":
            style = ("入場を確定しました", "checkmark.seal.fill", .green)
        case "already_admitted":
            style = ("入場済みです", "exclamationmark.triangle.fill", .orange)
        case "cancelled":
            style = ("取消済みのチケット", "xmark.octagon.fill", .red)
        case "wrong_screening":
            style = ("上映回が違います", "arrow.triangle.swap", .orange)
        case "screening_cancelled":
            style = ("上映中止", "xmark.octagon.fill", .red)
        case "finished":
            style = ("上映終了", "clock.badge.xmark", .gray)
        case "not_found":
            style = ("チケットが見つかりません", "questionmark.circle.fill", .red)
        case "":
            style = ("", "info.circle", .secondary)
        default:
            style = (result, "info.circle", .gray)
        }
        title = style.0
        systemImage = style.1
        tint = style.2
    }
}
