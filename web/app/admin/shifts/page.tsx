"use client";

import { useEffect, useState } from "react";
import { patch, post } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { hm, mdhm } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Modal, Notice } from "@/components/ui";
import { AdminPage, BusinessDays, DayTabs, fromJstInput, jstDateTime, numOrNull, pickDefaultDay, toJstInput, useActions } from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

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
  requests: { member_id: string; member_name: string; preference: string; note: string }[] | null;
};
type Exchange = {
  id: string;
  status: string;
  reason: string;
  created_at: string;
  decided_at: string | null;
  from_name: string;
  to_name: string;
  decided_by_name: string | null;
  location: string;
  starts_at: string;
  ends_at: string;
};
type Member = { id: string; name: string; active: boolean; roles: string[] };

const prefLabel: Record<string, string> = { want: "◎ 希望", ok: "○ 可能", ng: "× 不可" };
const prefTone: Record<string, "ok" | "info" | "danger"> = { want: "ok", ok: "info", ng: "danger" };
const prefOrder: Record<string, number> = { want: 0, ok: 1, ng: 3 };
const exStatusLabel: Record<string, string> = {
  requested: "相手の回答待ち",
  accepted: "管理者の承認待ち",
  declined: "相手が辞退",
  cancelled: "取り下げ",
  approved: "承認済み",
  rejected: "却下",
};

export default function ShiftsPage() {
  const { run, ui } = useActions();
  const bd = useFetch<BusinessDays>("/business-days");
  const members = useFetch<Member[]>("/admin/members");
  const [day, setDay] = useState("");
  useEffect(() => {
    if (!day && bd.data) setDay(pickDefaultDay(bd.data));
  }, [bd.data, day]);
  const shifts = useLive<{ slots: Slot[]; warnings: string[] }>(day ? `/staff/shifts?day=${day}` : null, ["shifts"]);
  const exchanges = useLive<Exchange[]>("/staff/shift-exchanges", ["shifts"]);
  const [editing, setEditing] = useState<Slot | null>(null);
  const activeMembers = (members.data ?? []).filter((m) => m.active && !(m.roles.length === 1 && m.roles[0] === "display"));
  const pending = (exchanges.data ?? []).filter((e) => e.status === "accepted");
  const others = (exchanges.data ?? []).filter((e) => e.status !== "accepted");

  return (
    <AdminPage title="シフト配置">
      <p className="help">
        流れ：部員が希望を提出 → 管理者が配置（確定） → 本人が確認。交代は「申請 → 相手が承諾 → 管理者が承認」で確定配置が更新されます。配置・変更は本人に通知されます。
      </p>

      <h2>交代申請の承認待ち{pending.length > 0 && <> <Badge tone="warn">{pending.length}件</Badge></>}</h2>
      <ErrorBox error={exchanges.error} />
      {exchanges.data && pending.length === 0 && <Empty>承認待ちの交代申請はありません</Empty>}
      {pending.map((e) => (
        <ExchangeCard key={e.id} e={e} run={run} reload={exchanges.reload} />
      ))}

      <ErrorBox error={bd.error} />
      {bd.data && <DayTabs days={bd.data.days} value={day} onChange={setDay} />}
      {day && <LiveStatus lastOk={shifts.lastOk} stale={shifts.stale} connected={shifts.connected} error={shifts.error} />}
      <ErrorBox error={shifts.error} />
      {shifts.data && shifts.data.warnings.length > 0 && (
        <Notice kind="warn">
          <strong>⚠ 警告（{shifts.data.warnings.length}件）</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {shifts.data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {shifts.data && shifts.data.slots.length === 0 && <Empty>この日のシフト枠はありません</Empty>}
      <div className="grid-2">
        {shifts.data?.slots.map((s) => (
          <SlotCard key={s.id} s={s} members={activeMembers} run={run} reload={shifts.reload} onEdit={() => setEditing(s)} />
        ))}
      </div>
      {editing && <EditSlot s={editing} onClose={() => setEditing(null)} run={run} reload={shifts.reload} />}

      <CreateSlot days={bd.data?.days ?? []} defaultDay={day} run={run} reload={shifts.reload} />

      {others.length > 0 && (
        <details className="card">
          <summary>その他の交代申請の履歴（{others.length}件）</summary>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>シフト</th>
                  <th>申請者 → 相手</th>
                  <th>状態</th>
                  <th>申請日時</th>
                </tr>
              </thead>
              <tbody>
                {others.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {mdhm(e.starts_at)}〜{hm(e.ends_at)} {e.location}
                    </td>
                    <td>
                      {e.from_name} → {e.to_name}
                    </td>
                    <td>
                      {exStatusLabel[e.status] ?? e.status}
                      {e.decided_by_name && <div className="help">{e.decided_by_name}</div>}
                    </td>
                    <td className="help">{mdhm(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {ui}
    </AdminPage>
  );
}

function ExchangeCard({ e, run, reload }: { e: Exchange; run: Run; reload: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const decide = (action: "approve" | "reject") =>
    run(async () => {
      await post(`/admin/shift-exchanges/${e.id}/decide`, { action, reason: reason.trim() });
      await reload();
    }, action === "approve" ? "交代を承認しました" : "交代を却下しました");
  return (
    <div className="card">
      <div className="row-between">
        <strong>
          {mdhm(e.starts_at)}〜{hm(e.ends_at)} {e.location}
        </strong>
        <Badge tone="warn">相手承諾済・承認待ち</Badge>
      </div>
      <p>
        {e.from_name} さん → {e.to_name} さん に交代
        {e.reason && <span className="help">（理由：{e.reason}）</span>}
      </p>
      <div className="row">
        <label className="grow">
          <span className="label">コメント（任意・両者に通知されます）</span>
          <input value={reason} maxLength={200} onChange={(ev) => setReason(ev.target.value)} />
        </label>
        <ActionButton className="btn btn-ok" confirm={`${e.from_name}さんの配置を外し、${e.to_name}さんを配置します。よろしいですか？`} onClick={() => decide("approve")}>
          承認
        </ActionButton>
        <ActionButton className="btn btn-danger" confirm="この交代申請を却下します。よろしいですか？" onClick={() => decide("reject")}>
          却下
        </ActionButton>
      </div>
    </div>
  );
}

function SlotCard({ s, members, run, reload, onEdit }: { s: Slot; members: Member[]; run: Run; reload: () => Promise<void>; onEdit: () => void }) {
  const [memberId, setMemberId] = useState("");
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const assigned = new Set(s.assignments.map((a) => a.member_id));
  const prefs = new Map((s.requests ?? []).map((r) => [r.member_id, r]));
  const candidates = members
    .filter((m) => !assigned.has(m.id))
    .sort((a, b) => (prefOrder[prefs.get(a.id)?.preference ?? ""] ?? 2) - (prefOrder[prefs.get(b.id)?.preference ?? ""] ?? 2) || a.name.localeCompare(b.name, "ja"));
  const short = s.required_count - s.assigned_count;
  const selectedPref = prefs.get(memberId)?.preference;

  return (
    <section className={`card slot-card${s.active ? "" : " inactive"}`}>
      <div className="row-between">
        <div>
          <strong>
            {hm(s.starts_at)}〜{hm(s.ends_at)}
          </strong>{" "}
          {s.location}
        </div>
        <div className="chips">
          {!s.active && <Badge tone="neutral">無効</Badge>}
          <Badge tone={short > 0 ? "danger" : "ok"}>
            {s.assigned_count}／{s.required_count}人{short > 0 ? `（${short}人不足）` : ""}
          </Badge>
        </div>
      </div>
      {s.note && <p className="help">メモ：{s.note}</p>}

      <h3>確定配置</h3>
      {s.assignments.length === 0 && <p className="muted">まだ配置されていません</p>}
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {s.assignments.map((a) => {
          const p = prefs.get(a.member_id);
          return (
            <li key={a.id} className="row-between" style={{ padding: "2px 0" }}>
              <span>
                {a.member_name} {p ? <Badge tone={prefTone[p.preference]}>{prefLabel[p.preference]}</Badge> : <Badge>希望未提出</Badge>}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setReason("");
                  setRemoving({ id: a.id, name: a.member_name });
                }}
              >
                外す
              </button>
            </li>
          );
        })}
      </ul>

      {s.active && (
        <div className="row" style={{ marginTop: 8 }}>
          <label className="grow">
            <span className="label">部員を配置</span>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">選択してください</option>
              {candidates.map((m) => {
                const p = prefs.get(m.id);
                return (
                  <option key={m.id} value={m.id}>
                    {m.name}（{p ? prefLabel[p.preference] : "希望未提出"}）
                  </option>
                );
              })}
            </select>
          </label>
          <ActionButton
            className="btn btn-primary"
            disabled={!memberId}
            confirm={selectedPref === "ng" ? "この部員はこの枠を「不可」と希望しています。それでも配置しますか？" : undefined}
            onClick={() =>
              run(async () => {
                await post(`/admin/shift-slots/${s.id}/assignments`, { member_id: memberId });
                setMemberId("");
                await reload();
              }, "配置しました")
            }
          >
            配置
          </ActionButton>
        </div>
      )}

      {s.requests && s.requests.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>提出された希望（{s.requests.length}人）</summary>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {s.requests.map((r) => (
              <li key={r.member_id}>
                {r.member_name}：{prefLabel[r.preference] ?? r.preference}
                {r.note && <span className="help">（{r.note}）</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" onClick={onEdit}>
          枠を編集
        </button>
        <ActionButton
          className="btn btn-sm btn-ghost"
          confirm={s.active ? "この枠を無効にします（配置済みの人には変更が通知されます）。よろしいですか？" : undefined}
          onClick={() =>
            run(async () => {
              await patch(`/admin/shift-slots/${s.id}`, { active: !s.active });
              await reload();
            }, s.active ? "枠を無効にしました" : "枠を有効にしました")
          }
        >
          {s.active ? "枠を無効にする" : "枠を有効に戻す"}
        </ActionButton>
      </div>

      {removing && (
        <Modal open onClose={() => setRemoving(null)} title="配置を外す">
          <p>
            {hm(s.starts_at)}〜{hm(s.ends_at)} {s.location} から <strong>{removing.name}</strong> さんを外します。本人に理由とともに通知されます。
          </p>
          <label className="field">
            <span className="label">理由</span>
            <textarea maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：人数調整のため" />
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setRemoving(null)}>
              やめる
            </button>
            <ActionButton
              className="btn btn-danger"
              disabled={!reason.trim()}
              onClick={async () => {
                const ok = await run(async () => {
                  await post(`/admin/shift-assignments/${removing.id}/remove`, { reason: reason.trim() });
                  await reload();
                }, "配置を外しました");
                if (ok) setRemoving(null);
              }}
            >
              外す
            </ActionButton>
          </div>
        </Modal>
      )}
    </section>
  );
}

function EditSlot({ s, onClose, run, reload }: { s: Slot; onClose: () => void; run: Run; reload: () => Promise<void> }) {
  const [location, setLocation] = useState(s.location);
  const [starts, setStarts] = useState(toJstInput(s.starts_at));
  const [ends, setEnds] = useState(toJstInput(s.ends_at));
  const [required, setRequired] = useState(String(s.required_count));
  const [note, setNote] = useState(s.note);
  const req = numOrNull(required);
  const valid = location.trim() && starts && ends && starts < ends && req !== null && req >= 1;
  return (
    <Modal open onClose={onClose} title="シフト枠の編集">
      {s.assignments.length > 0 && <Notice kind="info">配置済みの{s.assignments.length}人に変更が通知されます。</Notice>}
      <div className="form-grid">
        <label className="span-2">
          <span className="label">担当場所</span>
          <input value={location} maxLength={50} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label>
          <span className="label">開始（日本時間）</span>
          <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </label>
        <label>
          <span className="label">終了（日本時間）</span>
          <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
        </label>
        <label>
          <span className="label">必要人数</span>
          <input type="number" min={1} inputMode="numeric" value={required} onChange={(e) => setRequired(e.target.value)} />
        </label>
        <label className="span-2">
          <span className="label">メモ</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
        <ActionButton
          className="btn btn-primary"
          disabled={!valid}
          onClick={async () => {
            const ok = await run(async () => {
              await patch(`/admin/shift-slots/${s.id}`, {
                location: location.trim(),
                starts_at: fromJstInput(starts),
                ends_at: fromJstInput(ends),
                required_count: req,
                note,
              });
              await reload();
            }, "シフト枠を変更しました");
            if (ok) onClose();
          }}
        >
          保存
        </ActionButton>
      </div>
    </Modal>
  );
}

function CreateSlot({ days, defaultDay, run, reload }: { days: BusinessDays["days"]; defaultDay: string; run: Run; reload: () => Promise<void> }) {
  const [day, setDay] = useState("");
  const [location, setLocation] = useState("");
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("13:00");
  const [required, setRequired] = useState("2");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (defaultDay) setDay(defaultDay);
  }, [defaultDay]);
  const req = numOrNull(required);
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>シフト枠を追加</h2>
      <div className="form-grid">
        <label>
          <span className="label">営業日</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => (
              <option key={d.day} value={d.day}>
                {d.label}（{d.day}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">担当場所</span>
          <input value={location} maxLength={50} onChange={(e) => setLocation(e.target.value)} placeholder="例：やきうどん会計" />
        </label>
        <label>
          <span className="label">開始</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          <span className="label">終了</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label>
          <span className="label">必要人数</span>
          <input type="number" min={1} inputMode="numeric" value={required} onChange={(e) => setRequired(e.target.value)} />
        </label>
        <label className="span-2">
          <span className="label">メモ（任意）</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div>
          <ActionButton
            className="btn btn-primary"
            disabled={!day || !location.trim() || !start || !end || start >= end || req === null || req < 1}
            onClick={() =>
              run(async () => {
                await post("/admin/shift-slots", {
                  location: location.trim(),
                  starts_at: jstDateTime(day, start),
                  ends_at: jstDateTime(day, end),
                  required_count: req,
                  note,
                });
                setLocation("");
                setNote("");
                await reload();
              }, "シフト枠を追加しました")
            }
          >
            追加
          </ActionButton>
        </div>
      </div>
      <span className="help">日をまたぐ枠は作成後に「枠を編集」で終了日時を変更してください。</span>
    </section>
  );
}
