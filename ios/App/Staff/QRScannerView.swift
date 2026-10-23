import SwiftUI
import AVFoundation
import UIKit

/// カメラ権限の状態
enum CameraPermission {
    case authorized, notDetermined, denied

    static var current: CameraPermission {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    static func request() async -> CameraPermission {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        return granted ? .authorized : .denied
    }
}

/// カメラ権限の確認つきQRスキャナー。拒否されたときは設定への案内を出す（手入力欄は呼び出し側に置く）。
struct QRScannerPanel: View {
    /// false の間は読み取り結果を通知しない（結果表示中など）
    let isActive: Bool
    let onScan: (String) -> Void

    @State private var permission = CameraPermission.current
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            switch permission {
            case .authorized:
                QRScannerView(isActive: isActive, onScan: onScan)
                    .overlay {
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 3, dash: [12, 8]))
                            .padding(40)
                            .accessibilityHidden(true)
                    }
                    .accessibilityLabel("QRコード読み取り用カメラ")
            case .notDetermined:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("カメラの使用許可を確認しています…")
                }
                .task {
                    permission = await CameraPermission.request()
                }
            case .denied:
                VStack(spacing: 12) {
                    Image(systemName: "camera.badge.ellipsis")
                        .font(.largeTitle)
                        .accessibilityHidden(true)
                    Text("カメラが使えません")
                        .font(.headline)
                    Text("設定アプリでカメラを許可するか、下の欄に番号を手入力してください。")
                        .font(.callout)
                        .multilineTextAlignment(.center)
                    Button("設定を開く") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            openURL(url)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .padding()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 300)
        .background(Color.black.opacity(permission == .authorized ? 1 : 0.06))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// AVFoundation（AVCaptureMetadataOutput）による QR 読み取り
struct QRScannerView: UIViewControllerRepresentable {
    let isActive: Bool
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onScan = onScan
        controller.isActive = isActive
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {
        controller.onScan = onScan
        controller.isActive = isActive
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var isActive = true {
        didSet {
            if isActive && !oldValue {
                lastValue = nil
            }
        }
    }

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "jp.example.gakusai.scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var lastValue: String?
    private var lastScanAt = Date.distantPast
    private var isConfigured = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard isConfigured else { return }
        let captureSession = session
        sessionQueue.async {
            if !captureSession.isRunning { captureSession.startRunning() }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let captureSession = session
        sessionQueue.async {
            if captureSession.isRunning { captureSession.stopRunning() }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            return
        }
        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) {
            output.metadataObjectTypes = [.qr]
        }
        session.commitConfiguration()

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
        isConfigured = true

        let captureSession = session
        sessionQueue.async {
            captureSession.startRunning()
        }
    }

    // デリゲートはメインキューで呼ばれる（setMetadataObjectsDelegate の queue: .main）
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        MainActor.assumeIsolated {
            self.handle(value)
        }
    }

    private func handle(_ value: String?) {
        guard isActive, let value, !value.isEmpty else { return }
        // 同じコードを連続で読み取らない（2秒以内の再検出は無視）
        let now = Date()
        if value == lastValue && now.timeIntervalSince(lastScanAt) < 2 { return }
        lastValue = value
        lastScanAt = now
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onScan?(value)
    }
}
