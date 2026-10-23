"use client";

import { useParams, usePathname } from "next/navigation";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "@/lib/api";
import { useLive } from "@/lib/hooks";
import { businessLabel, hm } from "@/lib/format";
import { BoardClock, StaleBanner, useHeartbeat, useNow } from "@/components/visitor/display";

type Board = {
  department: { id: string; name: string; business_status: string; mobile_order_enabled: boolean; site_code_enabled: boolean; notice: string };
  cooking: number[];
  ready: number[];
  server_time: string;
};
type SiteCode =
  | { enabled: false; server_time: string }
  | { enabled: true; code: string; valid_from: string; valid_until: string; server_time: string };

export default function UdonDisplay() {
  const { deptId } = useParams<{ deptId: string }>();
  const pathname = usePathname();
  const { data, error, lastOk, stale } = useLive<Board>(
    deptId ? `/public/departments/${encodeURIComponent(deptId)}/board` : null,
    ["orders", "departments"],
    10000,
  );

  // サーバー時刻と端末時刻の差（ms）。カウントダウンと時計はサーバー基準にする。
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (data?.server_time && lastOk) setOffset(new Date(data.server_time).getTime() - lastOk.getTime());
  }, [data, lastOk]);

  // 現地確認コード（表示用アカウントでログインが必要）
  const [code, setCode] = useState<SiteCode | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCode = useCallback(async () => {
    if (!deptId) return;
    if (timer.current) clearTimeout(timer.current);
    let nextMs = 15000;
    try {
      const fetchedAt = Date.now();
      const c = await get<SiteCode>(`/display/departments/${encodeURIComponent(deptId)}/site-code`);
      const off = new Date(c.server_time).getTime() - fetchedAt;
      setOffset(off);
      setCode(c);
      setCodeError(null);
      setNeedLogin(false);
      if (c.enabled) {
        // 切替時刻の少し後に取り直す
        const untilLocal = new Date(c.valid_until).getTime() - off;
        nextMs = Math.max(1000, Math.min(15000, untilLocal - Date.now() + 700));
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setNeedLogin(true);
        setCode(null);
        nextMs = 30000;
      } else {
        setCodeError(e instanceof Error ? e.message : "取得できません");
        nextMs = 5000;
      }
    }
    timer.current = setTimeout(fetchCode, nextMs);
  }, [deptId]);

  useEffect(() => {
    fetchCode();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchCode]);

  useHeartbeat("udon", deptId ?? null, () => setNeedLogin(true));

  const now = useNow(1000, offset);
  const d = data?.department;
  const showStale = stale || !!error;
  const codeEnabled = d ? d.site_code_enabled : code?.enabled;

  let codeView: ReactNode = null;
  if (codeEnabled) {
    if (needLogin) {
      codeView = (
        <div className="board-codebox">
          <div className="lbl">確認コードを表示するには表示用アカウントでのログインが必要です</div>
          <a href={`/staff/login?next=${encodeURIComponent(pathname)}`} style={{ fontSize: "1.6rem" }}>
            ログインする
          </a>
        </div>
      );
    } else if (code && code.enabled && now !== null) {
      const remain = Math.floor((new Date(code.valid_until).getTime() - now) / 1000);
      const valid = remain > 0 && !codeError;
      codeView = (
        <div className="board-codebox" aria-live="polite">
          <div className="lbl">スマホ注文の確認コード</div>
          {valid ? (
            <>
              <div className="board-code" aria-label={`確認コード ${code.code.split("").join(" ")}`}>
                {code.code}
              </div>
              <div className="sub">
                {hm(code.valid_until)}に切り替わります（あと{Math.floor(remain / 60)}分{String(remain % 60).padStart(2, "0")}秒）
              </div>
            </>
          ) : (
            <div className="board-code" style={{ color: "#ffffff66" }} aria-label="確認コード更新中">
              ---
            </div>
          )}
          {!valid && <div className="sub">{codeError ? `⚠ コードを取得できません：${codeError}` : "新しいコードを取得しています…"}</div>}
        </div>
      );
    } else if (codeError) {
      codeView = (
        <div className="board-codebox">
          <div className="lbl">⚠ 確認コードを取得できません。スタッフにお声がけください</div>
        </div>
      );
    }
  }

  return (
    <main className="board">
      <div className="board-head">
        <h1>{d?.name ?? "やきうどん"} 呼出状況</h1>
        <BoardClock offsetMs={offset} />
      </div>

      <StaleBanner show={showStale} lastOk={lastOk} />

      {!data && !error && <p className="board-empty">読み込み中…</p>}

      {d && d.business_status !== "open" && (
        <div className="board-status" role="status">
          ■ {businessLabel[d.business_status] ?? d.business_status}
          {d.business_status === "paused" && "：ただいま受付を一時停止しています"}
          {d.business_status === "closed" && "：本日の営業は終了しました"}
          {d.business_status === "before" && "：まもなく営業を開始します"}
        </div>
      )}
      {d && d.business_status === "open" && !d.mobile_order_enabled && (
        <div className="board-status">現在スマホ注文は停止中です。店頭でご注文ください</div>
      )}
      {d?.notice && <div className="board-notice">{d.notice}</div>}

      {d?.business_status === "open" && d.mobile_order_enabled && codeView}

      {data && (
        <div className="board-cols">
          <section className="board-col" aria-labelledby="col-cooking">
            <h2 id="col-cooking">♨ 調理中</h2>
            {data.cooking.length === 0 ? (
              <p className="board-empty">なし</p>
            ) : (
              <div className="board-nums">
                {data.cooking.map((n) => (
                  <span key={n} className="board-num">
                    {n}
                  </span>
                ))}
              </div>
            )}
          </section>
          <section className="board-col" aria-labelledby="col-ready">
            <h2 id="col-ready">✓ 受け取り可能</h2>
            {data.ready.length === 0 ? (
              <p className="board-empty">なし</p>
            ) : (
              <div className="board-nums">
                {data.ready.map((n) => (
                  <span key={n} className="board-num ready">
                    {n}
                  </span>
                ))}
              </div>
            )}
            {data.ready.length > 0 && <p style={{ fontSize: "1.4rem" }}>番号の方は受け取り口へお越しください（お支払いがまだの方は先にお支払いを）</p>}
          </section>
        </div>
      )}

      <div className="board-meta">最終更新 {lastOk ? lastOk.toLocaleTimeString("ja-JP") : "—"}</div>
    </main>
  );
}
