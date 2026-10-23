"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

type Props = {
  onScan: (text: string) => void;
  /** 手動入力欄の見出し（カメラが使えないときの代替手段） */
  manualLabel?: string;
  manualPlaceholder?: string;
  onManual?: (text: string) => void;
  paused?: boolean;
};

/**
 * カメラでQRを読み取る。カメラ権限が拒否された／使えない場合は手動入力を案内する。
 * 同じQRの連続検出は1.5秒間無視する（同時読取の防止はサーバー側でも行う）。
 */
export function QrScanner({ onScan, manualLabel = "番号を手入力", manualPlaceholder = "", onManual, paused }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"starting" | "running" | "denied" | "unavailable">("starting");
  const [manual, setManual] = useState("");
  const last = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const detector: any =
      typeof window !== "undefined" && "BarcodeDetector" in window
        ? new (window as any).BarcodeDetector({ formats: ["qr_code"] })
        : null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (e) {
        setStatus((e as Error).name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const v = videoRef.current!;
      v.srcObject = stream;
      v.setAttribute("playsinline", "true");
      await v.play().catch(() => {});
      setStatus("running");
      tick();
    }

    async function tick() {
      if (stopped) return;
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2 && !pausedRef.current) {
        let text: string | null = null;
        if (detector) {
          try {
            const codes = await detector.detect(v);
            if (codes.length) text = codes[0].rawValue;
          } catch {
            /* fallthrough */
          }
        }
        if (!text) {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (w && h) {
            const scale = Math.min(1, 640 / w);
            c.width = Math.floor(w * scale);
            c.height = Math.floor(h * scale);
            const ctx = c.getContext("2d", { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code?.data) text = code.data;
          }
        }
        if (text) {
          const now = Date.now();
          if (text !== last.current.text || now - last.current.at > 1500) {
            last.current = { text, at: now };
            if (navigator.vibrate) navigator.vibrate(60);
            onScanRef.current(text);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={videoRef} muted playsInline />
        <canvas ref={canvasRef} hidden />
        {status === "running" && <div className="scanner-frame" aria-hidden />}
        {status === "starting" && <p className="scanner-msg">カメラを起動しています…</p>}
        {status === "denied" && (
          <p className="scanner-msg">カメラの使用が許可されていません。端末の設定で許可するか、下の欄に番号を入力してください。</p>
        )}
        {status === "unavailable" && <p className="scanner-msg">この端末ではカメラを使えません。下の欄に番号を入力してください。</p>}
        {paused && status === "running" && <p className="scanner-msg dim">読み取り一時停止中</p>}
      </div>
      {onManual && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) {
              onManual(manual.trim());
              setManual("");
            }
          }}
        >
          <label className="grow">
            <span className="label">{manualLabel}</span>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={manualPlaceholder} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn">
            照会
          </button>
        </form>
      )}
    </div>
  );
}
