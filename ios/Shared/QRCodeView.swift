import SwiftUI
import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// CoreImage の CIQRCodeGenerator で QR コード画像を作る。
enum QRCodeRenderer {
    static func image(for value: String, scale: CGFloat = 12) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: nil)
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// QRコード表示。ダークモードでも読み取れるよう、常に白背景と余白（クワイエットゾーン）を付ける。
struct QRCodeView: View {
    let value: String
    var label: String = "QRコード"

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color.white
            if let image {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(16)
            } else {
                ProgressView()
                    .tint(.black)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.3)))
        .task(id: value) {
            image = QRCodeRenderer.image(for: value)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
    }
}
