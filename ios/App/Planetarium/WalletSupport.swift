import SwiftUI
import PassKit
import UIKit

/// Apple 公式の「Apple Walletに追加」ボタン（PKAddPassButton）。表記は端末の言語に合わせて自動で切り替わる。
struct AddToWalletButton: UIViewRepresentable {
    let action: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    func makeUIView(context: Context) -> PKAddPassButton {
        let button = PKAddPassButton(addPassButtonStyle: .black)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: PKAddPassButton, context: Context) {
        context.coordinator.action = action
    }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func tapped() {
            action()
        }
    }
}

/// .pkpass を Wallet に追加する標準画面
struct AddPassesSheet: UIViewControllerRepresentable {
    let pass: PKPass

    func makeUIViewController(context: Context) -> UIViewController {
        PKAddPassesViewController(pass: pass) ?? UIViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

/// シート表示用に PKPass を Identifiable にする
struct PresentedPass: Identifiable {
    let id = UUID()
    let pass: PKPass
}
