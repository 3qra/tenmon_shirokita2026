"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, errorMessage, patch, post } from "@/lib/api";
import { useFetch, useLive } from "@/lib/hooks";
import { hm } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, LiveStatus, Modal, Notice } from "@/components/ui";
import {
  AdminPage,
  BusinessDays,
  DayTabs,
  Department,
  fromJstInput,
  numOrNull,
  pickDefaultDay,
  toJstInput,
  useActions,
} from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

type Screening = {
  id: string;
  department_id: string;
  title: string;
  business_day: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  reserve_quota: number | null;
  reserved_count: number;
  walkin_count: number;
  booking_opens_at: string | null;
  booking_closes_at: string | null;
  visibility: string;
  booking_status: string;
  run_status: string;
  manually_edited: boolean;
  cancel_reason?: string;
  admitted_count: number;
  taken: number;
  symbol: string;
  status_text: string;
  advance_available: number;
  walkin_available: number;
  advance_open: boolean;
};

const bookingLabel: Record<string, string> = { open: "予約受付中", paused: "受付停止", closed: "受付終了" };
const runLabel: Record<string, string> = { scheduled: "開催予定", running: "上映中", finished: "終了", cancelled: "中止" };
const visLabel: Record<string, string> = { public: "公開", hidden: "非表示" };

export default function ScreeningsPage() {
  const { run, ui } = useActions();
  const bd = useFetch<BusinessDays>("/business-days");
  const depts = useFetch<Department[]>("/staff/departments");
  const [day, setDay] = useState("");
  useEffect(() => {
    if (!day && bd.data) setDay(pickDefaultDay(bd.data));
  }, [bd.data, day]);
  const list = useLive<{ screenings: Screening[]; server_time: string }>(day ? `/staff/screenings?day=${day}` : null, ["screenings"]);
  const planetDepts = (depts.data ?? []).filter((d) => d.kind === "planetarium");
  const [editing, setEditing] = useState<Screening | null>(null);
  const [cancelling, setCancelling] = useState<Screening | null>(null);

  return (
    <AdminPage title="上映管理">
      <p className="help">
        公開状態（公開／非表示）・予約受付（受付中／停止／終了）・開催状態（予定／上映中／終了／中止）はそれぞれ独立しています。
        非表示や受付停止にしても既存の予約は失効しません。既存予約のある枠は削除せず、必要なら「上映中止」を使います。
      </p>
      <ErrorBox error={bd.error} />
      {bd.data && <DayTabs days={bd.data.days} value={day} onChange={setDay} />}
      {day && <LiveStatus lastOk={list.lastOk} stale={list.stale} connected={list.connected} error={list.error} />}
      <ErrorBox error={list.error} />

      {list.data && list.data.screenings.length === 0 && <Empty>この日の上映枠はありません。下の「自動生成」から作成できます。</Empty>}
      {list.data && list.data.screenings.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>時刻</th>
                <th>タイトル</th>
                <th className="num">定員</th>
                <th className="num">予約／当日／入場</th>
                <th>空席</th>
                <th>公開</th>
                <th>予約受付</th>
                <th>開催状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.data.screenings.map((s) => (
                <ScreeningRow key={s.id} s={s} run={run} reload={list.reload} onEdit={() => setEditing(s)} onCancel={() => setCancelling(s)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <EditModal s={editing} onClose={() => setEditing(null)} run={run} reload={list.reload} />}
      {cancelling && <CancelModal s={cancelling} onClose={() => setCancelling(null)} run={run} reload={list.reload} />}

      <Generator days={bd.data?.days ?? []} depts={planetDepts} defaultDay={day} run={run} reload={list.reload} />
      <ManualSlot depts={planetDepts} defaultDay={day} run={run} reload={list.reload} />
      {ui}
    </AdminPage>
  );
}

function ScreeningRow({ s, run, reload, onEdit, onCancel }: { s: Screening; run: Run; reload: () => Promise<void>; onEdit: () => void; onCancel: () => void }) {
  const cancelled = s.run_status === "cancelled";
  const save = (body: Record<string, unknown>, ok: string) =>
    run(async () => {
      await patch(`/admin/screenings/${s.id}`, body);
      await reload();
    }, ok);
  return (
    <tr className={cancelled ? "row-danger" : s.run_status === "finished" ? "row-muted" : ""}>
      <td className="num">
        {hm(s.starts_at)}〜{hm(s.ends_at)}
      </td>
      <td>
        {s.title}
        {s.manually_edited && (
          <div>
            <Badge tone="info">手動変更済</Badge>
          </div>
        )}
        {cancelled && s.cancel_reason && <div className="help">中止理由：{s.cancel_reason}</div>}
      </td>
      <td className="num">
        {s.capacity}
        {s.reserve_quota !== null && <div className="help">予約枠 {s.reserve_quota}</div>}
      </td>
      <td className="num">
        {s.reserved_count}／{s.walkin_count}／{s.admitted_count}
        <div className="help">確保 {s.taken}</div>
      </td>
      <td>
        <span className="symbol" aria-label={`空席 ${s.symbol}`}>
          {s.symbol}
        </span>
        {s.status_text && <div className="help">{s.status_text}</div>}
      </td>
      <td>
        <select
          className="inline-input"
          aria-label="公開状態"
          disabled={cancelled}
          value={s.visibility}
          onChange={(e) => save({ visibility: e.target.value }, `${visLabel[e.target.value]}にしました`)}
        >
          <option value="public">公開</option>
          <option value="hidden">非表示</option>
        </select>
      </td>
      <td>
        <select
          className="inline-input"
          aria-label="予約受付"
          disabled={cancelled}
          value={s.booking_status}
          onChange={(e) => save({ booking_status: e.target.value }, `${bookingLabel[e.target.value]}にしました`)}
        >
          {Object.entries(bookingLabel).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td>
        {cancelled ? (
          <Badge tone="danger">✕ 中止</Badge>
        ) : (
          <select
            className="inline-input"
            aria-label="開催状態"
            value={s.run_status}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "finished" && !window.confirm("「終了」にすると、入場記録のある鑑賞者へクーポンが自動発券されます（設定がある場合）。よろしいですか？")) {
                e.target.value = s.run_status;
                return;
              }
              void save({ run_status: v }, `${runLabel[v]}にしました`);
            }}
          >
            <option value="scheduled">開催予定</option>
            <option value="running">上映中</option>
            <option value="finished">終了</option>
          </select>
        )}
      </td>
      <td>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <button className="btn btn-sm" disabled={cancelled} onClick={onEdit}>
            編集
          </button>
          <button className="btn btn-sm btn-danger" disabled={cancelled} onClick={onCancel}>
            中止
          </button>
        </div>
      </td>
    </tr>
  );
}

function EditModal({ s, onClose, run, reload }: { s: Screening; onClose: () => void; run: Run; reload: () => Promise<void> }) {
  const [title, setTitle] = useState(s.title);
  const [capacity, setCapacity] = useState(String(s.capacity));
  const [quota, setQuota] = useState(s.reserve_quota === null ? "" : String(s.reserve_quota));
  const [opens, setOpens] = useState(toJstInput(s.booking_opens_at));
  const [closes, setCloses] = useState(toJstInput(s.booking_closes_at));
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    const body: Record<string, unknown> = {};
    if (title.trim() !== s.title) body.title = title.trim();
    const cap = numOrNull(capacity);
    if (cap === null || cap < 1) return setErr("定員は1以上の数で入力してください");
    if (cap !== s.capacity) body.capacity = cap;
    const q = numOrNull(quota);
    if (quota.trim() === "") {
      if (s.reserve_quota !== null) body.clear_reserve_quota = true;
    } else if (q === null || q < 0 || q > cap) {
      return setErr("事前予約枠は0〜定員の範囲で入力してください");
    } else if (q !== s.reserve_quota) body.reserve_quota = q;
    if (opens !== toJstInput(s.booking_opens_at) && opens) body.booking_opens_at = fromJstInput(opens);
    if (closes !== toJstInput(s.booking_closes_at) && closes) body.booking_closes_at = fromJstInput(closes);
    if (Object.keys(body).length === 0) return onClose();
    try {
      await patch(`/admin/screenings/${s.id}`, body);
    } catch (e) {
      // 422（確保済み人数を下回る定員など）はここで表示する
      setErr(e instanceof ApiError && e.status === 422 ? `変更できません：${e.message}` : errorMessage(e));
      return;
    }
    await run(reload, "上映枠を変更しました");
    onClose();
  };

  return (
    <Modal open onClose={onClose} title={`上映枠の編集（${hm(s.starts_at)}）`}>
      <p className="help">
        確保済み {s.taken}人（予約 {s.reserved_count}・当日 {s.walkin_count}）。確保済み人数を下回る定員・予約数を下回る予約枠にはできません。
      </p>
      {err && (
        <div className="banner banner-danger" role="alert">
          {err}
        </div>
      )}
      <label className="field">
        <span className="label">タイトル</span>
        <input value={title} maxLength={50} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="form-grid">
        <label>
          <span className="label">定員（人）</span>
          <input type="number" min={Math.max(1, s.taken)} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </label>
        <label>
          <span className="label">事前予約枠（人・空欄で区別なし）</span>
          <input type="number" min={0} inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} />
        </label>
        <label>
          <span className="label">予約受付開始（日本時間）</span>
          <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} />
        </label>
        <label>
          <span className="label">予約受付締切（日本時間）</span>
          <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
        </label>
      </div>
      <span className="help">事前予約枠を空欄にすると予約と当日受付で定員を共有します。受付開始・締切は設定後に空にはできません。</span>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          閉じる
        </button>
        <ActionButton className="btn btn-primary" onClick={submit}>
          保存
        </ActionButton>
      </div>
    </Modal>
  );
}

function CancelModal({ s, onClose, run, reload }: { s: Screening; onClose: () => void; run: Run; reload: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  return (
    <Modal open onClose={onClose} title="上映中止">
      <Notice kind="danger">
        {hm(s.starts_at)}〜 「{s.title}」を中止します。この操作は取り消せません。
        <br />
        予約 {s.reserved_count}人分の確定予約は「上映中止に伴う取消」となり、予約者の確認画面に中止が表示されます。当日受付 {s.walkin_count}人分も含め、来場者への案内が必要です。
      </Notice>
      <label className="field">
        <span className="label">中止理由（予約者にも表示されます・必須）</span>
        <textarea maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：機材トラブルのため" />
      </label>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        予約が取り消され、元に戻せないことを理解しました
      </label>
      <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          やめる
        </button>
        <ActionButton
          className="btn btn-danger"
          disabled={!reason.trim() || !ack}
          confirm="本当にこの上映を中止しますか？"
          onClick={async () => {
            const ok = await run(async () => {
              const r = await post<{ affected_reservations: number }>(`/admin/screenings/${s.id}/cancel`, { reason: reason.trim() });
              await reload();
              return r;
            }, "上映を中止しました");
            if (ok) onClose();
          }}
        >
          上映を中止する
        </ActionButton>
      </div>
    </Modal>
  );
}

type RuleForm = {
  department_id: string;
  business_day: string;
  title: string;
  window_start: string;
  window_end: string;
  interval_min: string;
  duration_min: string;
  turnover_min: string;
  capacity: string;
  reserve_quota: string;
  booking_opens_before_min: string;
  booking_closes_before_min: string;
};
type Preview = { slots: { starts_at: string; ends_at: string; conflict?: string }[]; will_create: number };

function Generator({ days, depts, defaultDay, run, reload }: { days: BusinessDays["days"]; depts: Department[]; defaultDay: string; run: Run; reload: () => Promise<void> }) {
  const [f, setF] = useState<RuleForm>({
    department_id: "",
    business_day: "",
    title: "",
    window_start: "10:00",
    window_end: "16:00",
    interval_min: "15",
    duration_min: "10",
    turnover_min: "5",
    capacity: "18",
    reserve_quota: "",
    booking_opens_before_min: "",
    booking_closes_before_min: "0",
  });
  const firstDeptId = depts[0]?.id ?? "";
  useEffect(() => {
    setF((x) =>
      x.department_id && x.business_day
        ? x
        : { ...x, department_id: x.department_id || firstDeptId, business_day: x.business_day || defaultDay },
    );
  }, [firstDeptId, defaultDay]);
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof RuleForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const body = useMemo(
    () => ({
      department_id: f.department_id,
      business_day: f.business_day,
      title: f.title.trim(),
      window_start: f.window_start,
      window_end: f.window_end,
      interval_min: numOrNull(f.interval_min) ?? 15,
      duration_min: numOrNull(f.duration_min) ?? 0,
      turnover_min: numOrNull(f.turnover_min) ?? 0,
      capacity: numOrNull(f.capacity) ?? 0,
      reserve_quota: numOrNull(f.reserve_quota),
      booking_opens_before_min: numOrNull(f.booking_opens_before_min),
      booking_closes_before_min: numOrNull(f.booking_closes_before_min) ?? 0,
    }),
    [f],
  );
  const key = JSON.stringify(body);
  const fresh = preview && preview.key === key;

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>上映枠の自動生成</h2>
      <p className="help">
        時間帯の中で「開始間隔」ごとに枠を作ります。既存の枠（予約済み・手動変更済みを含む）と重なる時刻は作成せず、既存枠を削除・上書きすることはありません。同じ条件で再実行しても重複しません。
      </p>
      {depts.length === 0 && <Notice kind="warn">プラネタリウム部門がありません。</Notice>}
      <div className="form-grid">
        <label>
          <span className="label">部門</span>
          <select value={f.department_id} onChange={set("department_id")}>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">営業日</span>
          <select value={f.business_day} onChange={set("business_day")}>
            {days.map((d) => (
              <option key={d.day} value={d.day}>
                {d.label}（{d.day}）
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          <span className="label">タイトル</span>
          <input value={f.title} maxLength={50} onChange={set("title")} placeholder="例：秋の星空" />
        </label>
        <label>
          <span className="label">時間帯の開始</span>
          <input type="time" value={f.window_start} onChange={set("window_start")} />
        </label>
        <label>
          <span className="label">時間帯の終了</span>
          <input type="time" value={f.window_end} onChange={set("window_end")} />
          <span className="help">上映終了がこの時刻を超える枠は作りません</span>
        </label>
        <label>
          <span className="label">開始間隔（分）</span>
          <input type="number" min={5} inputMode="numeric" value={f.interval_min} onChange={set("interval_min")} />
          <span className="help">初期値15分（変更可）。次の上映が始まるまでの間隔です</span>
        </label>
        <label>
          <span className="label">上映時間（分）</span>
          <input type="number" min={1} inputMode="numeric" value={f.duration_min} onChange={set("duration_min")} />
        </label>
        <label>
          <span className="label">入替時間（分）</span>
          <input type="number" min={0} inputMode="numeric" value={f.turnover_min} onChange={set("turnover_min")} />
          <span className="help">上映時間＋入替時間 ≦ 開始間隔 にしてください</span>
        </label>
        <label>
          <span className="label">定員（人）</span>
          <input type="number" min={1} inputMode="numeric" value={f.capacity} onChange={set("capacity")} />
          <span className="help">初期値18人（ダミー・変更可）</span>
        </label>
        <label>
          <span className="label">事前予約枠（人・任意）</span>
          <input type="number" min={0} inputMode="numeric" value={f.reserve_quota} onChange={set("reserve_quota")} />
          <span className="help">空欄なら予約と当日で定員を共有</span>
        </label>
        <label>
          <span className="label">予約受付開始（開始の何分前・任意）</span>
          <input type="number" min={0} inputMode="numeric" value={f.booking_opens_before_min} onChange={set("booking_opens_before_min")} />
          <span className="help">空欄ならすぐに受付開始</span>
        </label>
        <label>
          <span className="label">予約締切（開始の何分前）</span>
          <input type="number" min={0} inputMode="numeric" value={f.booking_closes_before_min} onChange={set("booking_closes_before_min")} />
          <span className="help">0なら上映開始まで受付</span>
        </label>
      </div>
      {err && (
        <div className="banner banner-danger" role="alert">
          {err}
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <ActionButton
          className="btn"
          disabled={!f.department_id || !f.business_day || !f.title.trim()}
          onClick={async () => {
            setErr(null);
            try {
              const data = await post<Preview>("/admin/screening-rules/preview", body);
              setPreview({ key, data });
            } catch (e) {
              setPreview(null);
              setErr(errorMessage(e));
            }
          }}
        >
          プレビュー
        </ActionButton>
        <ActionButton
          className="btn btn-primary"
          disabled={!fresh || preview.data.will_create === 0}
          confirm={fresh ? `${preview.data.will_create}枠を作成します。よろしいですか？` : undefined}
          onClick={() =>
            run(async () => {
              const r = await post<{ created: number; skipped: number }>("/admin/screening-rules", body);
              setPreview(null);
              await reload();
              window.alert(`${r.created}枠を作成しました（重複のため作成しなかった枠：${r.skipped}）`);
            }, "上映枠を生成しました")
          }
        >
          生成
        </ActionButton>
        {preview && !fresh && <span className="help">条件が変わりました。もう一度プレビューしてください。</span>}
      </div>

      {fresh && (
        <div style={{ marginTop: 12 }}>
          <p>
            作成予定：<strong>{preview.data.will_create}枠</strong>／全{preview.data.slots.length}枠（重複のため作成しない：
            {preview.data.slots.length - preview.data.will_create}枠）
          </p>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>開始</th>
                  <th>終了</th>
                  <th>結果</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.slots.map((sl) => (
                  <tr key={sl.starts_at} className={sl.conflict ? "row-skip" : ""}>
                    <td className="num">{hm(sl.starts_at)}</td>
                    <td className="num">{hm(sl.ends_at)}</td>
                    <td style={{ textDecoration: "none" }}>
                      {sl.conflict ? <Badge tone="warn">作成しない：{sl.conflict}</Badge> : <Badge tone="ok">作成</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ManualSlot({ depts, defaultDay, run, reload }: { depts: Department[]; defaultDay: string; run: Run; reload: () => Promise<void> }) {
  const [deptId, setDeptId] = useState("");
  const [title, setTitle] = useState("");
  const [starts, setStarts] = useState("");
  const [duration, setDuration] = useState("10");
  const [turnover, setTurnover] = useState("5");
  const [capacity, setCapacity] = useState("18");
  const [quota, setQuota] = useState("");
  const [opens, setOpens] = useState("");
  const [closes, setCloses] = useState("");
  const [visibility, setVisibility] = useState("public");
  useEffect(() => {
    if (!deptId && depts[0]) setDeptId(depts[0].id);
  }, [depts, deptId]);
  useEffect(() => {
    if (!starts && defaultDay) setStarts(`${defaultDay}T10:00`);
  }, [defaultDay, starts]);
  const cap = numOrNull(capacity);
  const dur = numOrNull(duration);
  const turn = numOrNull(turnover);
  const q = numOrNull(quota);

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>例外枠を手動で追加</h2>
      <p className="help">自動生成の規則に当てはまらない枠（特別上映など）を1件追加します。手動枠は「手動変更済」として扱われます。</p>
      <div className="form-grid">
        <label>
          <span className="label">部門</span>
          <select value={deptId} onChange={(e) => setDeptId(e.target.value)}>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          <span className="label">タイトル</span>
          <input value={title} maxLength={50} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span className="label">開始日時（日本時間）</span>
          <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </label>
        <label>
          <span className="label">上映時間（分）</span>
          <input type="number" min={1} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
        <label>
          <span className="label">入替時間（分）</span>
          <input type="number" min={0} inputMode="numeric" value={turnover} onChange={(e) => setTurnover(e.target.value)} />
        </label>
        <label>
          <span className="label">定員（人）</span>
          <input type="number" min={1} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </label>
        <label>
          <span className="label">事前予約枠（任意）</span>
          <input type="number" min={0} inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} />
        </label>
        <label>
          <span className="label">予約受付開始（任意）</span>
          <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} />
        </label>
        <label>
          <span className="label">予約締切（任意・空欄なら開始時刻）</span>
          <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
        </label>
        <label>
          <span className="label">公開状態</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="public">公開</option>
            <option value="hidden">非表示</option>
          </select>
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <ActionButton
          className="btn btn-primary"
          disabled={!deptId || !title.trim() || !starts || !cap || cap < 1 || !dur || dur < 1 || turn === null || turn < 0 || (q !== null && (q < 0 || q > cap))}
          confirm="この内容で上映枠を追加します。既存の枠と時間が重ならないか確認しましたか？"
          onClick={() =>
            run(async () => {
              await post("/admin/screenings", {
                department_id: deptId,
                title: title.trim(),
                starts_at: fromJstInput(starts),
                duration_min: dur,
                turnover_min: turn,
                capacity: cap,
                reserve_quota: q,
                booking_opens_at: fromJstInput(opens),
                booking_closes_at: fromJstInput(closes),
                visibility,
              });
              setTitle("");
              await reload();
            }, "上映枠を追加しました")
          }
        >
          枠を追加
        </ActionButton>
      </div>
    </section>
  );
}
