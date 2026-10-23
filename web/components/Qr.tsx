"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** QRコード表示。value は推測困難なトークン（個人情報は入れない）。 */
export function Qr({ value, size = 220, label }: { value: string; size?: number; label?: string }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: size * 2 })
      .then(setSrc)
      .catch(() => setSrc(""));
  }, [value, size]);
  return (
    <figure className="qr">
      {src ? <img src={src} width={size} height={size} alt={label ?? "QRコード"} /> : <div style={{ width: size, height: size }} />}
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
