import Foundation
import Observation

/// スタッフのログイン状態。セッショントークンはキーチェーンに保存する（この端末のみ）。
@MainActor
@Observable
final class StaffSession {
    private(set) var token: String?
    private(set) var staff: StaffUser?
    private(set) var isWorking = false
    private(set) var errorMessage: String?

    private static let keychainAccount = "gakusai.staffToken"

    init() {
        token = KeychainStore.string(for: Self.keychainAccount)
    }

    var isLoggedIn: Bool { token != nil }

    func has(any roles: [String]) -> Bool {
        staff?.has(any: roles) ?? false
    }

    func login(loginID: String, password: String) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let response: LoginResponse = try await APIClient.shared.post(
                "/auth/login",
                body: LoginRequest(loginId: loginID.trimmingCharacters(in: .whitespaces), password: password)
            )
            token = response.token
            staff = response.staff
            KeychainStore.set(response.token, for: Self.keychainAccount)
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// 保存済みトークンでスタッフ情報を取り直す（期限切れならログアウト状態にする）
    func restore() async {
        guard let token else { return }
        do {
            let me: MeResponse = try await APIClient.shared.get("/auth/me", bearer: token)
            staff = me.staff
            errorMessage = nil
        } catch let error as APIError where error.isUnauthorized {
            clear()
            errorMessage = "ログインの有効期限が切れました。もう一度ログインしてください"
        } catch let error where error.isCancellation {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    func logout() async {
        if let token {
            let _: OKResponse? = try? await APIClient.shared.post("/auth/logout", bearer: token)
        }
        clear()
    }

    /// API呼び出しのエラーを画面用メッセージにする。401 ならログアウト状態にする。
    func message(for error: Error) -> String {
        if let apiError = error as? APIError, apiError.isUnauthorized {
            clear()
            return "ログインの有効期限が切れました。もう一度ログインしてください"
        }
        return error.userMessage
    }

    private func clear() {
        token = nil
        staff = nil
        KeychainStore.set(nil, for: Self.keychainAccount)
    }
}
