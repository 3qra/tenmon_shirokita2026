import SwiftUI
import Observation

enum PlanetariumRoute: Hashable {
    case screening(id: String)
    case reservation(token: String)
}

struct ScreeningDay: Identifiable {
    var id: String { day }
    let day: String
    let screenings: [Screening]
}

@MainActor
@Observable
final class ScreeningListModel {
    private(set) var screenings: [Screening] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var lastUpdated: Date?

    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    /// 営業日ごとにまとめる
    var days: [ScreeningDay] {
        let grouped = Dictionary(grouping: screenings, by: \.businessDay)
        return grouped.keys.sorted().map { ScreeningDay(day: $0, screenings: grouped[$0] ?? []) }
    }

    var isStale: Bool { loadError != nil && !screenings.isEmpty }

    func load() async {
        isLoading = screenings.isEmpty
        defer { isLoading = false }
        do {
            let response: ScreeningsResponse = try await APIClient.shared.get("/public/screenings")
            screenings = response.screenings
            loadError = nil
            lastUpdated = Date()
        } catch let error where error.isCancellation {
            return
        } catch {
            loadError = error.userMessage
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
}

/// プラネタリウムの上映一覧（空席記号 ○△× と受付状態）
struct ScreeningListView: View {
    @State private var model = ScreeningListModel()
    @State private var path: [PlanetariumRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = model.loadError {
                    Section {
                        ErrorMessageView(message: error) { Task { await model.load() } }
                    }
                }
                if model.isLoading {
                    ProgressView("上映予定を読み込み中…")
                        .frame(maxWidth: .infinity, minHeight: 80)
                } else if model.screenings.isEmpty && model.loadError == nil {
                    ContentUnavailableView("上映予定はありません", systemImage: "moon.stars",
                                           description: Text("公開中の上映枠がありません。"))
                }
                ForEach(model.days) { group in
                    Section(Fmt.businessDay(group.day)) {
                        ForEach(group.screenings) { screening in
                            NavigationLink(value: PlanetariumRoute.screening(id: screening.id)) {
                                ScreeningRow(screening: screening)
                            }
                        }
                    }
                }
                Section {
                    SeatLegend()
                    FreshnessFooter(lastUpdated: model.lastUpdated, isStale: model.isStale)
                }
            }
            .navigationTitle("プラネタリウム")
            .refreshable { await model.load() }
            .task { await model.load() }
            .onAppear { model.start() }
            .onDisappear { model.stop() }
            .navigationDestination(for: PlanetariumRoute.self) { route in
                switch route {
                case .screening(let id):
                    ScreeningDetailView(screeningID: id) { token in
                        path.append(.reservation(token: token))
                    }
                case .reservation(let token):
                    ReservationDetailView(token: token)
                }
            }
        }
    }
}

struct ScreeningRow: View {
    let screening: Screening

    var body: some View {
        HStack(spacing: 14) {
            SeatSymbolView(symbol: screening.symbol)
            VStack(alignment: .leading, spacing: 4) {
                Text(Fmt.timeRange(screening.startsAt, screening.endsAt))
                    .font(.title3.weight(.bold).monospacedDigit())
                Text(screening.title)
                    .font(.body)
                availabilityText
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var availabilityText: Text {
        if !screening.statusText.isEmpty {
            return Text(screening.statusText)
        }
        if screening.canReserve {
            return Text("事前予約受付中")
        }
        if screening.walkinAvailable {
            return Text("当日受付のみ")
        }
        return Text(SeatSymbol.description(screening.symbol))
    }
}

/// 空席記号。記号＋文字で表し、色だけに頼らない。
struct SeatSymbolView: View {
    let symbol: String
    @ScaledMetric(relativeTo: .title) private var size: CGFloat = 52

    var body: some View {
        VStack(spacing: 0) {
            Text(symbol)
                .font(.system(size: size * 0.55, weight: .bold))
            Text(SeatSymbol.description(symbol))
                .font(.caption2)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(width: size, height: size)
        .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
        .foregroundStyle(tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SeatSymbol.description(symbol))
    }

    private var tint: Color {
        switch symbol {
        case "○": return .green
        case "△": return .orange
        case "×": return .red
        default: return .secondary
        }
    }
}

private struct SeatLegend: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("○ 空席あり　△ 残りわずか　× 満席")
            Text("受付停止・上映中止などは文字で表示します。")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}
