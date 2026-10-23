"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage, post, put } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { hm, md, mdhm } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Notice, Toast } from "@/components/ui";
import { StaffShell, useStaff } from "@/components/StaffShell";
import type { BusinessDays } from "../_components/types";

type Slot = {
  id: string;
  business_day: string;
  location: string;
  starts_at: string;
  ends_at: string;
  required_count: number;
  note: string;
  active: boolean;
  assigned_count: number;
  assignments: { id: string; member_id: string; member_name: string }[];
  my_request: { preference: "want" | "ok" | "ng"; note: string } | null;
  mine: boolean;
};
type ShiftsResp = { slots: Slot[]; warnings: string[] };
type Exchange = {
  id: string;
  status: "requested" | "accepted" | "approved" | "declined" | "rejected" | "cancelled";
  reason: string;
  created_at: string;
  from_member_id: string;
  from_name: string;
  to_member_id: string;
  to_name: string;
  decided_by_name: string | null;
  location: string;
  starts_at: string;
  ends_at: string;
};

const PREFS = [
  { key: "want", label: "◎ 入りたい" },
  { key: "ok", label: "○ 入れる" },
  { key: "ng", label: "✕ 入れない" },
] as const;

const exStatus: Record<Exchange["status"], { label: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  requested: { label: "相手の回答待ち", tone: "warn" },
  accepted: { label: "管理者の承認待ち", tone: "info" },
  approved: { label: "✓ 承認・交代済", tone: "ok" },
  declined: { label: "相手が辞退", tone: "neutral" },
  rejected: { label: "管理者が却下", tone: "danger" },
  cancelled: { label: "取り下げ", tone: "neutral" },
};

export default function ShiftsPage() {
  return (
    <StaffShell>
      <Shifts />
    </StaffShell>
  );
}

function Shifts() {
  const staff = useStaff();
  const { data: days } = useFetch<BusinessDays>("/business-days");
  const [day, setDay] = useState("");
  useEffect(() => {
    if (!days || day) return;
    setDay(days.days.some((d) => d.day === days.today) ? days.today : days.days[0]?.day ?? days.today);
  }, [days, day]);
  const live = useLive<ShiftsResp>(day ? `/staff/shifts?day=${day}` : null, ["shifts"], 30000);
  const ex = useLive<Exchange[]>("/staff/shift-exchanges", ["shifts"], 30000);
  const { data: members } = useFetch<{ id: string; name: string }[]>("/staff/members/directory");
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const slots = live.data?.slots ?? [];
  const exReload = ex.reload;
  const liveReload = live.reload;
  const refresh = useCallback(() => {
    exReload();
    liveReload();
  }, [exReload, liveReload]);

  return (
    <>
      <div className="section-title">
        <h1 style={{ margin: 0 }}>シフト</h1>
        <LiveStatus lastOk={live.lastOk} stale={live.stale} connected={live.connected} error={live.error} />
      </div>
      <Notice kind="info">
        希望は「◎入りたい／○入れる／✕入れない」で提出し、管理者が配置を確定します。交代は <strong>申請 → 相手が承諾 → 管理者が承認</strong> で確定し、承認されるまでは元の担当のままです。
      </Notice>
      {days && (
        <div className="tabs" role="tablist">
          {days.days.map((d) => (
            <button key={d.day} role="tab" aria-selected={day === d.day} onClick={() => setDay(d.day)}>
              {d.label}（{md(d.day)}）
            </button>
          ))}
        </div>
      )}
      <ErrorBox error={live.error && !live.data ? live.error : null} />
      {live.data && live.data.warnings.length > 0 && (
        <Notice kind="warn">
          <strong>⚠ 配置の注意</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {live.data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {live.data && slots.length === 0 && <Empty>この日のシフト枠はありません</Empty>}
      {slots.map((s) => (
        <SlotCard key={s.id} slot={s} myId={staff.id} members={members ?? []} onDone={(m) => { setToast(m); refresh(); }} />
      ))}

      <h2>交代の申請・依頼</h2>
      <ErrorBox error={ex.error && !ex.data ? ex.error : null} />
      {ex.data && ex.data.length === 0 && <Empty>交代の申請・依頼はありません</Empty>}
      {ex.data?.map((e) => (
        <ExchangeCard key={e.id} e={e} myId={staff.id} onDone={(m) => { setToast(m); refresh(); }} />
      ))}
      <Toast message={toast} onDone={clearToast} />
    </>
  );
}

function SlotCard({ slot: s, myId, members, onDone }: { slot: Slot; myId: string; members: { id: string; name: string }[]; onDone: (m: string) => void }) {
  const [pref, setPref] = useState<string>(s.my_request?.preference ?? "");
  const [note, setNote] = useState(s.my_request?.note ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [exOpen, setExOpen] = useState(false);
  const [exTo, setExTo] = useState("");
  const [exReason, setExReason] = useState("");
  const [exErr, setExErr] = useState<string | null>(null);
  const myAssignment = s.assignments.find((a) => a.member_id === myId);
  const changed = pref !== (s.my_request?.preference ?? "") || note !== (s.my_request?.note ?? "");
  const short = s.assigned_count < s.required_count;

  return (
    <section className={`card slot ${s.mine ? "mine" : ""}`}>
      <div className="row-between">
        <div>
          <strong className="num">
            {hm(s.starts_at)}–{hm(s.ends_at)}
          </strong>{" "}
          <strong>{s.location}</strong>
        </div>
        <div>
          {s.mine && <Badge tone="info">★ あなたの担当</Badge>}{" "}
          <Badge tone={short ? "warn" : "ok"}>
            {short ? "⚠ " : ""}
            {s.assigned_count}/{s.required_count}人
          </Badge>
          {!s.active && <Badge tone="neutral">無効</Badge>}
        </div>
      </div>
      {s.note && <p>{s.note}</p>}
      <p>
        <small>担当：{s.assignments.length ? s.assignments.map((a) => a.member_name).join("、") : "未配置"}</small>
      </p>

      <span className="label">あなたの希望{s.my_request ? `（提出済み：${PREFS.find((p) => p.key === s.my_request?.preference)?.label}）` : "（未提出）"}</span>
      <div className="seg pref" role="radiogroup" aria-label="希望">
        {PREFS.map((p) => (
          <button key={p.key} type="button" role="radio" aria-checked={pref === p.key} className={pref === p.key ? "seg-on" : ""} onClick={() => setPref(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="row">
        <label className="grow">
          <span className="label">メモ（任意）</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="例：14時以降なら可" />
        </label>
        <ActionButton
          className="btn btn-primary"
          disabled={!pref || !changed}
          onClick={async () => {
            setErr(null);
            try {
              await put(`/staff/shift-slots/${s.id}/request`, { preference: pref, note: note.trim() });
              onDone("希望を保存しました");
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        >
          {s.my_request ? "希望を更新" : "希望を提出"}
        </ActionButton>
      </div>
      <ErrorBox error={err} />

      {myAssignment && !exOpen && (
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setExOpen(true)}>
          この枠の交代を申請
        </button>
      )}
      {myAssignment && exOpen && (
        <div className="reason-box">
          <label className="field">
            <span className="label">交代してほしい相手</span>
            <select value={exTo} onChange={(e) => setExTo(e.target.value)}>
              <option value="">選んでください</option>
              {members
                .filter((m) => m.id !== myId && !s.assignments.some((a) => a.member_id === m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="label">理由（任意）</span>
            <input value={exReason} onChange={(e) => setExReason(e.target.value)} maxLength={200} />
          </label>
          <ErrorBox error={exErr} />
          <div className="row">
            <ActionButton
              className="btn btn-primary"
              disabled={!exTo}
              onClick={async () => {
                setExErr(null);
                try {
                  await post("/staff/shift-exchanges", { assignment_id: myAssignment.id, to_member_id: exTo, reason: exReason.trim() });
                  setExOpen(false);
                  setExTo("");
                  setExReason("");
                  onDone("交代を申請しました。相手の承諾を待っています");
                } catch (e) {
                  setExErr(errorMessage(e));
                }
              }}
            >
              申請する
            </ActionButton>
            <button className="btn btn-ghost" onClick={() => setExOpen(false)}>
              やめる
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ExchangeCard({ e, myId, onDone }: { e: Exchange; myId: string; onDone: (m: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const st = exStatus[e.status];
  const toMe = e.to_member_id === myId;
  const fromMe = e.from_member_id === myId;
  const respond = (action: string, msg: string) => async () => {
    setErr(null);
    try {
      await post(`/staff/shift-exchanges/${e.id}/respond`, { action });
      onDone(msg);
    } catch (er) {
      setErr(errorMessage(er));
    }
  };
  return (
    <div className="card">
      <div className="row-between">
        <strong>
          {md(e.starts_at)} {hm(e.starts_at)}–{hm(e.ends_at)} {e.location}
        </strong>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <p>
        {e.from_name} → {e.to_name}
        {toMe && "（あなたへの依頼）"}
        {fromMe && "（あなたの申請）"}
      </p>
      {e.reason && <p><small>理由：{e.reason}</small></p>}
      <p>
        <small>
          申請 {mdhm(e.created_at)}
          {e.decided_by_name && `・処理 ${e.decided_by_name}`}
        </small>
      </p>
      <ErrorBox error={err} />
      <div className="actions">
        {toMe && e.status === "requested" && (
          <>
            <ActionButton className="btn btn-ok" confirm="この交代を引き受けますか？（管理者の承認後に確定します）" onClick={respond("accept", "承諾しました。管理者の承認を待っています")}>
              引き受ける
            </ActionButton>
            <ActionButton className="btn" onClick={respond("decline", "辞退しました")}>
              辞退する
            </ActionButton>
          </>
        )}
        {fromMe && (e.status === "requested" || e.status === "accepted") && (
          <ActionButton className="btn" confirm="この申請を取り下げますか？" onClick={respond("cancel", "申請を取り下げました")}>
            取り下げる
          </ActionButton>
        )}
      </div>
    </div>
  );
}
