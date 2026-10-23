"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { hm, md, mdhm, reservationStatusLabel } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Modal, Notice, Toast } from "@/components/ui";
import { Qr } from "@/components/Qr";
import { QrScanner } from "@/components/QrScanner";
import { hasRole, StaffShell, useStaff } from "@/components/StaffShell";
import { BlockForm } from "../_components/OrderDetailView";
import { loadPref, ReasonAction, savePref, useIdempotent } from "../_components/common";
import { runStatusLabel, type BusinessDays, type Screening } from "../_components/types";

type ScreeningsResp = { screenings: Screening[]; server_time: string };
type TicketInfo = {
  id: string;
  ticket_no: string;
  seq: number;
  status: string;
  reservation_status: string;
  reservation_no: string;
  name: string;
  party_size: number;
  screening_id: string;
  title: string;
  starts_at: string;
  run_status: string;
  admitted_at?: string;
};
type CheckinResult = { result: string; message: string; ticket?: TicketInfo };
type Ticket = { id: string; seq?: number; ticket_no: string; status: string; admitted_at: string | null; entry_token?: string };
type ReservationDetail = {
  id: string;
  reservation_no: string;
  kind: "advance" | "walkin";
  name: string;
  party_size: number;
  status: string;
  cancel_reason: string | null;
  created_at: string;
  screening: { id: string; title: string; starts_at: string; ends_at: string; run_status: string; business_day: string; cancel_reason: string | null };
  tickets: Ticket[];
  coupons: { id: string; coupon_no: string; name: string; persons_total: number; persons_remaining: number; status: string }[];
  access_token?: string;
  url?: string;
};
type ReservationRow = {
  id: string;
  reservation_no: string;
  kind: "advance" | "walkin";
  name: string;
  party_size: number;
  status: string;
  created_at: string;
  cancel_reason: string | null;
  screening_id: string;
  title: string;
  starts_at: string;
  has_client_identity: boolean;
  admitted: number;
  tickets: Ticket[];
};

const TABS = [
  { key: "qr", label: "QR入場" },
  { key: "walkin", label: "当日受付" },
  { key: "search", label: "予約検索" },
  { key: "status", label: "上映状況" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function ReceptionPage() {
  return (
    <StaffShell roles={["reception", "admin"]}>
      <Reception />
    </StaffShell>
  );
}

/** 今の上映（上映中）か次の上映を既定にする */
function pickDefault(list: Screening[]): string {
  const now = Date.now();
  const alive = list.filter((s) => s.run_status !== "cancelled");
  const running = alive.find((s) => s.run_status === "running");
  if (running) return running.id;
  const next = alive
    .filter((s) => new Date(s.ends_at).getTime() > now && s.run_status !== "finished")
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0];
  if (next) return next.id;
  return alive[alive.length - 1]?.id ?? list[0]?.id ?? "";
}

function screeningLabel(s: Screening) {
  const st = s.run_status !== "scheduled" ? `［${runStatusLabel[s.run_status]}］` : s.status_text ? `［${s.status_text}］` : "";
  return `${hm(s.starts_at)} ${s.title}（空き${s.walkin_available}・入場${s.admitted_count}/${s.taken}）${st}`;
}

function Reception() {
  const [tab, setTab] = useState<TabKey>("qr");
  const live = useLive<ScreeningsResp>("/staff/screenings", ["screenings"], 15000);
  const screenings = useMemo(() => live.data?.screenings ?? [], [live.data]);
  const [sid, setSid] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!screenings.length) return;
    if (sid && screenings.some((s) => s.id === sid)) return;
    setSid(pickDefault(screenings));
  }, [screenings, sid]);

  const selected = screenings.find((s) => s.id === sid);

  return (
    <>
      <div className="section-title">
        <h1 style={{ margin: 0 }}>プラネ受付</h1>
        <LiveStatus lastOk={live.lastOk} stale={live.stale} connected={live.connected} error={live.error} />
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {(tab === "qr" || tab === "walkin") && (
        <label className="field">
          <span className="label">上映回</span>
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {screenings.length === 0 && <option value="">本日の上映はありません</option>}
            {screenings.map((s) => (
              <option key={s.id} value={s.id}>
                {screeningLabel(s)}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (tab === "qr" || tab === "walkin") && selected.run_status === "cancelled" && <Notice kind="danger">✕ この上映は中止されています</Notice>}
      {selected && (tab === "qr" || tab === "walkin") && selected.run_status === "finished" && <Notice kind="warn">この上映は終了しています</Notice>}

      {tab === "qr" && <QrTab screeningId={sid} />}
      {tab === "walkin" && <WalkinTab screening={selected} onDone={() => live.reload()} />}
      {tab === "search" && <SearchTab screenings={screenings} defaultSid={sid} onToast={setToast} />}
      {tab === "status" && <StatusTab />}
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}

// ------------------------------------------------------------
// QR入場
// ------------------------------------------------------------

function lookupBody(text: string, screeningId: string): Record<string, string> {
  const t = text.trim();
  // 受付番号（例 20-013-1）なら番号で、そうでなければQRのトークンとして照会
  if (/^\d{1,2}-\d{3,}-\d+$/.test(t)) return { ticket_no: t, screening_id: screeningId };
  return { token: t, screening_id: screeningId };
}

function ResultPanel({ r }: { r: CheckinResult }) {
  const t = r.ticket;
  const ok = r.result === "admitted";
  const pending = r.result === "ok";
  return (
    <div className={`result ${ok ? "result-ok" : pending ? "result-warn" : "result-ng"}`} role="alert" aria-live="assertive">
      <div className="mark" aria-hidden>
        {ok ? "✓" : pending ? "?" : "✕"}
      </div>
      <h2>{ok ? "入場OK" : pending ? "入場できます（未確定）" : r.message}</h2>
      {!ok && !pending && <p>入場させないでください</p>}
      {t && (
        <>
          <div className="ticket-no">{t.ticket_no}</div>
          <p>
            {t.name ? `${t.name} 様・` : ""}
            {t.party_size}名様の{t.seq}人目
          </p>
          <p>
            {hm(t.starts_at)} {t.title}
          </p>
          {r.result === "already_admitted" && t.admitted_at && <p>入場時刻：{hm(t.admitted_at)}</p>}
        </>
      )}
    </div>
  );
}

function QrTab({ screeningId }: { screeningId: string }) {
  const send = useIdempotent();
  const [direct, setDirect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckinResult | null>(null);
  const [pendingBody, setPendingBody] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const last = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const busyRef = useRef(false);

  useEffect(() => {
    setDirect(loadPref("staff.reception.direct") === "1");
  }, []);

  async function checkin(body: Record<string, string>) {
    setErr(null);
    try {
      const r = await send<CheckinResult>("POST", "/staff/checkin", body);
      setResult(r);
      setPendingBody(null);
      if (r.result === "admitted" && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(80);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "network" ? "通信できませんでした。もう一度押してください（同じ操作として扱われます）" : errorMessage(e));
    }
  }

  async function handle(text: string, manual = false) {
    if (!screeningId) {
      setErr("上映回を選んでください");
      return;
    }
    const now = Date.now();
    // 入場直後に同じQRが映り続けても「入場済み」と誤表示しないよう、同じ内容は10秒間無視
    if (!manual && last.current.text === text && now - last.current.at < 10000) return;
    if (busyRef.current) return;
    last.current = { text, at: now };
    busyRef.current = true;
    setBusy(true);
    setResult(null);
    setPendingBody(null);
    setErr(null);
    const body = lookupBody(text, screeningId);
    try {
      if (direct) {
        await checkin(body);
      } else {
        const r = await post<CheckinResult>("/staff/checkin/verify", body);
        setResult(r);
        if (r.result === "ok") setPendingBody(body);
      }
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section>
      <label className="check">
        <input
          type="checkbox"
          checked={direct}
          onChange={(e) => {
            setDirect(e.target.checked);
            savePref("staff.reception.direct", e.target.checked ? "1" : "0");
            setPendingBody(null);
          }}
        />
        読取と同時に入場を確定する
      </label>
      <QrScanner
        onScan={(t) => handle(t)}
        onManual={(t) => handle(t, true)}
        manualLabel="受付番号（例 20-013-1）を手入力"
        manualPlaceholder="20-013-1"
        paused={busy || !!pendingBody}
      />
      {busy && <p className="center">照会中…</p>}
      <ErrorBox error={err} />
      {result && <ResultPanel r={result} />}
      {pendingBody && (
        <div className="actions">
          <ActionButton className="btn btn-ok btn-xl" onClick={() => checkin(pendingBody)}>
            入場を確定
          </ActionButton>
          <button className="btn btn-block" onClick={() => { setPendingBody(null); setResult(null); }}>
            やめる（次を読み取る）
          </button>
        </div>
      )}
      {result && !pendingBody && (
        <button className="btn btn-block" onClick={() => { setResult(null); last.current = { text: "", at: 0 }; }}>
          表示を消して次を読み取る
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// 当日受付
// ------------------------------------------------------------

function WalkinTab({ screening, onDone }: { screening?: Screening; onDone: () => void }) {
  const send = useIdempotent();
  const [party, setParty] = useState(1);
  const [name, setName] = useState("");
  const [admitNow, setAdmitNow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ReservationDetail | null>(null);

  if (res) {
    return (
      <section className="card">
        <div className="result result-ok">
          <div className="mark" aria-hidden>
            ✓
          </div>
          <h2>当日受付が完了しました</h2>
          <div className="ticket-no">受付番号 {res.reservation_no}</div>
          <p>
            {hm(res.screening.starts_at)} {res.screening.title}・{res.party_size}名
            {res.tickets.every((t) => t.admitted_at) && "・入場済み"}
          </p>
        </div>
        {res.url && (
          <>
            <h3>お客様用の確認ページ</h3>
            <p>スマートフォンで読み取ってもらうと、チケットを表示できます。</p>
            <Qr value={res.url} label="予約確認ページ" />
            <p className="mono center">{res.url}</p>
          </>
        )}
        <h3>入場チケット</h3>
        <div className="qr-grid">
          {res.tickets.map((t) => (
            <div key={t.id} className="center">
              {t.entry_token ? <Qr value={t.entry_token} size={160} label={t.ticket_no} /> : <p>{t.ticket_no}</p>}
              {t.admitted_at ? <Badge tone="ok">✓ 入場済</Badge> : <Badge tone="neutral">未入場</Badge>}
            </div>
          ))}
        </div>
        <button
          className="btn btn-primary btn-xl"
          onClick={() => {
            setRes(null);
            setParty(1);
            setName("");
          }}
        >
          次の受付へ
        </button>
      </section>
    );
  }

  const max = screening ? Math.max(0, Math.min(50, screening.walkin_available)) : 0;
  const closed = !screening || screening.run_status === "cancelled" || screening.run_status === "finished";

  return (
    <section className="card">
      {screening && (
        <p>
          空き <strong className="num">{screening.walkin_available}</strong> 席（定員{screening.capacity}・予約{screening.reserved_count}・当日{screening.walkin_count}）
        </p>
      )}
      <span className="label">人数</span>
      <div className="stepper">
        <button className="btn" aria-label="1人減らす" onClick={() => setParty((p) => Math.max(1, p - 1))} disabled={party <= 1}>
          −
        </button>
        <output aria-live="polite">{party}</output>
        <span>名</span>
        <button className="btn" aria-label="1人増やす" onClick={() => setParty((p) => Math.min(Math.max(1, max), p + 1))} disabled={party >= max}>
          ＋
        </button>
      </div>
      <label className="field">
        <span className="label">お名前（任意）</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoComplete="off" />
      </label>
      <label className="check">
        <input type="checkbox" checked={admitNow} onChange={(e) => setAdmitNow(e.target.checked)} />
        受付と同時に入場済みにする
      </label>
      {screening && party > screening.walkin_available && <Notice kind="danger">✕ 空き席が足りません（残り{screening.walkin_available}席）</Notice>}
      <ErrorBox error={err} />
      <ActionButton
        className="btn btn-primary btn-xl"
        disabled={closed || party < 1 || party > max}
        onClick={async () => {
          if (!screening) return;
          setErr(null);
          try {
            const r = await send<ReservationDetail>("POST", "/staff/walkins", {
              screening_id: screening.id,
              party_size: party,
              name: name.trim(),
              admit_now: admitNow,
            });
            setRes(r);
            onDone();
          } catch (e) {
            setErr(e instanceof ApiError && e.code === "network" ? "通信できませんでした。もう一度押してください（同じ受付として扱われ、二重登録にはなりません）" : errorMessage(e));
          }
        }}
      >
        {party}名で受付する
      </ActionButton>
    </section>
  );
}

// ------------------------------------------------------------
// 予約検索
// ------------------------------------------------------------

function SearchTab({ screenings, defaultSid, onToast }: { screenings: Screening[]; defaultSid: string; onToast: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [rows, setRows] = useState<ReservationRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sid, setSid] = useState(defaultSid);
  const [open, setOpen] = useState<ReservationRow | null>(null);

  const run = useCallback(async (path: string) => {
    setLoading(true);
    setErr(null);
    try {
      setRows(await get<ReservationRow[]>(path));
      setQuery(path);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  const refresh = useCallback(() => (query ? run(query) : Promise.resolve()), [query, run]);

  return (
    <section>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) run(`/staff/reservations?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="grow">
          <span className="label">受付番号・チケット番号・お名前</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例：20-013 / 山田" />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!q.trim() || loading}>
          検索
        </button>
      </form>
      <div className="row">
        <label className="grow">
          <span className="label">上映回の予約一覧</span>
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {screenings.map((s) => (
              <option key={s.id} value={s.id}>
                {screeningLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={!sid || loading} onClick={() => run(`/staff/reservations?screening_id=${sid}`)}>
          一覧
        </button>
      </div>
      {loading && <p className="center">検索中…</p>}
      <ErrorBox error={err} />
      {rows && rows.length === 0 && <Empty>見つかりませんでした</Empty>}
      {rows?.map((r) => (
        <button key={r.id} className="rrow" onClick={() => setOpen(r)}>
          <div className="row-between">
            <strong className="num">{r.reservation_no}</strong>
            <span>
              <Badge tone={r.status === "confirmed" ? "ok" : "danger"}>{reservationStatusLabel[r.status] ?? r.status}</Badge>{" "}
              <Badge tone="neutral">{r.kind === "walkin" ? "当日" : "事前予約"}</Badge>
            </span>
          </div>
          <div>
            {r.name || "（名前なし）"}・{r.party_size}名・入場 {r.admitted}/{r.party_size}
          </div>
          <small>
            {md(r.starts_at)} {hm(r.starts_at)} {r.title}
          </small>
        </button>
      ))}
      <Modal open={!!open} onClose={() => setOpen(null)} title="予約の詳細">
        {open && (
          <ReservationView
            row={open}
            onChanged={(m) => {
              onToast(m);
              refresh();
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function ReservationView({ row, onChanged }: { row: ReservationRow; onChanged: (msg: string) => void }) {
  const staff = useStaff();
  const isAdmin = hasRole(staff, "admin");
  const send = useIdempotent();
  const { data: d, error, reload } = useFetch<ReservationDetail>(`/staff/reservations/${row.id}`);
  const [link, setLink] = useState<{ url: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "danger"; text: string } | null>(null);

  if (!d) return error ? <ErrorBox error={error} /> : <p className="empty">読み込み中…</p>;
  const confirmed = d.status === "confirmed";
  const anyAdmitted = d.tickets.some((t) => t.admitted_at);

  return (
    <div>
      <div className="big-num">{d.reservation_no}</div>
      <p>
        <Badge tone={confirmed ? "ok" : "danger"}>{reservationStatusLabel[d.status] ?? d.status}</Badge> <Badge tone="neutral">{d.kind === "walkin" ? "当日受付" : "事前予約"}</Badge>
      </p>
      <dl className="kv">
        <dt>お名前</dt>
        <dd>{d.name || "（なし）"}</dd>
        <dt>人数</dt>
        <dd>{d.party_size}名</dd>
        <dt>上映</dt>
        <dd>
          {md(d.screening.starts_at)} {hm(d.screening.starts_at)} {d.screening.title}（{runStatusLabel[d.screening.run_status] ?? d.screening.run_status}）
        </dd>
        <dt>受付日時</dt>
        <dd>{mdhm(d.created_at)}</dd>
        {d.cancel_reason && (
          <>
            <dt>取消理由</dt>
            <dd>{d.cancel_reason}</dd>
          </>
        )}
      </dl>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <h3>チケット</h3>
      {d.tickets.map((t) => (
        <div key={t.id} className="row-between" style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <div>
            <strong className="num">{t.ticket_no}</strong>{" "}
            {t.status === "void" ? <Badge tone="danger">✕ 無効</Badge> : t.admitted_at ? <Badge tone="ok">✓ 入場済 {hm(t.admitted_at)}</Badge> : <Badge tone="neutral">未入場</Badge>}
          </div>
          <div className="row">
            {confirmed && t.status === "valid" && !t.admitted_at && (
              <ActionButton
                className="btn btn-ok"
                confirm={`${t.ticket_no} を入場済みにしますか？`}
                onClick={async () => {
                  try {
                    const r = await send<CheckinResult>("POST", "/staff/checkin", { ticket_no: t.ticket_no, screening_id: d.screening.id });
                    setMsg(r.result === "admitted" ? { kind: "ok", text: `✓ ${t.ticket_no} の入場を確定しました` } : { kind: "danger", text: `✕ ${r.message}` });
                    await reload();
                    onChanged(r.result === "admitted" ? "入場を確定しました" : r.message);
                  } catch (e) {
                    setMsg({ kind: "danger", text: errorMessage(e) });
                  }
                }}
              >
                手動で入場
              </ActionButton>
            )}
            {isAdmin && t.admitted_at && (
              <ReasonAction
                label="入場取消"
                className="btn btn-sm"
                submitClassName="btn btn-danger"
                placeholder="例：誤って読み取った"
                onSubmit={async (reason) => {
                  await post(`/staff/tickets/${t.id}/revert`, { reason });
                  await reload();
                  onChanged("入場を取り消しました");
                }}
              />
            )}
          </div>
        </div>
      ))}

      {d.coupons.length > 0 && (
        <>
          <h3>発券済みクーポン</h3>
          <ul>
            {d.coupons.map((c) => (
              <li key={c.id}>
                {c.name}（{c.coupon_no}）残り{c.persons_remaining}/{c.persons_total}人分
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>操作</h3>
      <div className="stack">
          {confirmed && !anyAdmitted && (
            <ReasonAction
              label="予約を取り消す"
              className="btn"
              submitClassName="btn btn-danger"
              placeholder="例：お客様からの申し出"
              note={<Notice kind="warn">取り消すと席が解放され、チケットは使えなくなります。</Notice>}
              onSubmit={async (reason) => {
                await post(`/staff/reservations/${d.id}/cancel`, { reason });
                await reload();
                onChanged("予約を取り消しました");
              }}
            />
          )}
          {confirmed && anyAdmitted && <p className="muted">入場済みのチケットがあるため取り消せません。</p>}
          <ReasonAction
            label="確認ページURLを再発行"
            className="btn"
            submitClassName="btn btn-primary"
            placeholder="例：本人確認（名前・人数）済み"
            note={<Notice kind="warn">再発行すると以前のURLは使えなくなります。本人確認をしてから行ってください。</Notice>}
            onSubmit={async (reason) => {
              const r = await post<{ url: string }>(`/staff/reservations/${d.id}/reissue-link`, { reason });
              setLink(r);
              onChanged("URLを再発行しました");
            }}
          />
          {link && (
            <div className="card center">
              <h3>新しい確認ページ</h3>
              <Qr value={link.url} label="お客様に読み取ってもらってください" />
              <p className="mono">{link.url}</p>
            </div>
          )}
          {isAdmin && row.has_client_identity && <BlockForm sourceType="reservation" sourceId={d.id} onDone={() => onChanged("ブロックを登録しました")} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 上映状況
// ------------------------------------------------------------

function StatusTab() {
  const { data: days } = useFetch<BusinessDays>("/business-days");
  const [day, setDay] = useState("");
  const dayParam = day || days?.today || "";
  const live = useLive<ScreeningsResp>(dayParam ? `/staff/screenings?day=${dayParam}` : null, ["screenings"], 15000);
  const list = live.data?.screenings ?? [];
  return (
    <section>
      {days && (
        <div className="seg" role="radiogroup" aria-label="営業日">
          {days.days.map((d) => (
            <button key={d.day} type="button" role="radio" aria-checked={d.day === dayParam} className={d.day === dayParam ? "seg-on" : ""} onClick={() => setDay(d.day)}>
              {d.day === dayParam ? "● " : ""}
              {d.label}（{md(d.day)}）
            </button>
          ))}
        </div>
      )}
      <ErrorBox error={live.error} />
      {live.data && list.length === 0 && <Empty>上映はありません</Empty>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>時刻</th>
                <th>演目</th>
                <th className="num">定員</th>
                <th className="num">予約</th>
                <th className="num">当日</th>
                <th className="num">入場</th>
                <th>空き</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={s.run_status === "cancelled" ? "strike" : ""}>
                  <td className="num">
                    {hm(s.starts_at)}–{hm(s.ends_at)}
                  </td>
                  <td>{s.title}</td>
                  <td className="num">{s.capacity}</td>
                  <td className="num">{s.reserved_count}</td>
                  <td className="num">{s.walkin_count}</td>
                  <td className="num">
                    {s.admitted_count}/{s.taken}
                  </td>
                  <td>
                    <span className="symbol" aria-hidden>
                      {s.symbol}
                    </span>{" "}
                    <small>残{s.walkin_available}</small>
                  </td>
                  <td>
                    {runStatusLabel[s.run_status]}
                    {s.status_text && s.status_text !== runStatusLabel[s.run_status] && <small>・{s.status_text}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">空き：○ 余裕あり　△ 残りわずか　× 満席</p>
    </section>
  );
}
