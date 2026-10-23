import SwiftUI

enum StaffRoute: Hashable {
    case checkin
    case couponScan
    case kitchen
}

/// スタッフタブ：ログインと業務ツール。アプリにない業務は Web のスタッフ画面で行う。
struct StaffHomeView: View {
    @Environment(StaffSession.self) private var session

    var body: some View {
        NavigationStack {
            Group {
                if session.isLoggedIn {
                    StaffToolsList()
                } else {
                    StaffLoginView()
                }
            }
            .navigationTitle("スタッフ")
            .navigationDestination(for: StaffRoute.self) { route in
                switch route {
                case .checkin:
                    CheckinView(session: session)
                case .couponScan:
                    CouponScanView(session: session)
                case .kitchen:
                    KitchenView(session: session)
                }
            }
        }
        .task { await session.restore() }
    }
}

private struct StaffToolsList: View {
    @Environment(StaffSession.self) private var session
    @State private var showLogoutConfirm = false

    private let receptionRoles = ["reception", "admin"]
    private let cashierRoles = ["cashier", "treasurer", "admin"]
    private let kitchenRoles = ["kitchen", "cashier", "admin"]

    var body: some View {
        List {
            Section {
                if let staff = session.staff {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(staff.name)
                            .font(.title3.weight(.bold))
                        Text(staff.roles.map(StaffUser.roleLabel).joined(separator: "・"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } else {
                    ProgressView("確認中…")
                }
                if let message = session.errorMessage {
                    ErrorMessageView(message: message)
                }
            }

            Section("アプリでできる業務") {
                if session.has(any: receptionRoles) {
                    toolLink(.checkin, title: "入場チェックイン", subtitle: "チケットのQRを読み取って入場確定",
                             systemImage: "qrcode.viewfinder")
                }
                if session.has(any: cashierRoles) {
                    toolLink(.couponScan, title: "クーポン確認", subtitle: "クーポンQRの条件・残り人数を確認",
                             systemImage: "tag")
                }
                if session.has(any: kitchenRoles) {
                    toolLink(.kitchen, title: "キッチン", subtitle: "調理開始・完了の操作",
                             systemImage: "flame")
                }
                if session.staff != nil
                    && !session.has(any: receptionRoles + cashierRoles + kitchenRoles) {
                    Text("アプリで使える業務の権限がありません。")
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Link(destination: AppConfig.webBaseURL.appending(path: "staff/orders")) {
                    Label("Web管理画面を開く", systemImage: "safari")
                        .frame(minHeight: 44)
                }
                if session.has(any: ["admin"]) {
                    Link(destination: AppConfig.webBaseURL.appending(path: "admin")) {
                        Label("管理者画面を開く（Web）", systemImage: "gearshape")
                            .frame(minHeight: 44)
                    }
                }
            } header: {
                Text("その他の業務")
            } footer: {
                Text("会計・受け渡し・当日受付・予約管理・現金・シフト・各種設定は Web のスタッフ画面で行います。Web では改めてログインが必要です。")
            }

            Section {
                Button("ログアウト", role: .destructive) {
                    showLogoutConfirm = true
                }
                .frame(minHeight: 44)
            }
        }
        .confirmationDialog("ログアウトしますか？", isPresented: $showLogoutConfirm, titleVisibility: .visible) {
            Button("ログアウト", role: .destructive) {
                Task { await session.logout() }
            }
            Button("キャンセル", role: .cancel) {}
        }
    }

    private func toolLink(_ route: StaffRoute, title: String, subtitle: String, systemImage: String) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .frame(width: 36)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 56)
        }
    }
}

struct StaffLoginView: View {
    @Environment(StaffSession.self) private var session
    @State private var loginID = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field { case loginID, password }

    var body: some View {
        Form {
            Section {
                TextField("ログインID", text: $loginID)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .loginID)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .password }
                    .frame(minHeight: 44)
                SecureField("パスワード", text: $password)
                    .textContentType(.password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .frame(minHeight: 44)
            } header: {
                Text("スタッフログイン")
            } footer: {
                Text("部員個人のアカウントでログインしてください。操作はアカウントに記録されます。")
            }

            if let message = session.errorMessage {
                Section {
                    ErrorMessageView(message: message)
                }
            }

            Section {
                Button(action: submit) {
                    if session.isWorking {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        LargeButtonLabel(title: "ログイン", systemImage: "person.badge.key")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(loginID.isEmpty || password.isEmpty || session.isWorking)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
    }

    private func submit() {
        guard !loginID.isEmpty, !password.isEmpty else { return }
        Task {
            await session.login(loginID: loginID, password: password)
            if session.isLoggedIn { password = "" }
        }
    }
}
