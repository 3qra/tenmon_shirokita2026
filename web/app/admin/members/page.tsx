"use client";

import { useState } from "react";
import { patch, post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { roleLabel, yen } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox, Modal } from "@/components/ui";
import { useStaff } from "@/components/StaffShell";
import { AdminPage, useActions } from "../_components/admin";

type Run = ReturnType<typeof useActions>["run"];

type Member = { id: string; name: string; login_id: string; active: boolean; created_at: string; roles: string[]; wallet_account_id: string | null };
type CashAccount = {
  id: string;
  name: string;
  kind: string;
  member_id: string | null;
  member_name: string | null;
  active: boolean;
  cash_balance: number;
  voucher_balance: number;
  pending_transfers: number;
};

const ROLES = ["admin", "cashier", "kitchen", "reception", "treasurer", "member", "display"];
const roleHelp: Record<string, string> = {
  admin: "全管理機能",
  cashier: "注文・入金・受け渡し",
  kitchen: "調理操作",
  reception: "予約照会・当日受付・入場",
  treasurer: "返金・回収・精算",
  member: "シフト閲覧・希望・交代",
  display: "共有表示端末専用",
};
const accountKindLabel: Record<string, string> = { safe: "金庫", register: "共用レジ", wallet: "部員の財布" };

export default function MembersPage() {
  const { run, ui } = useActions();
  const members = useFetch<Member[]>("/admin/members");
  const [editing, setEditing] = useState<Member | null>(null);

  return (
    <AdminPage title="部員・現金保管先">
      <h2>部員アカウント</h2>
      <ErrorBox error={members.error} />
      {members.data?.length === 0 && <Empty>部員がいません</Empty>}
      {members.data && members.data.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>名前</th>
                <th>ログインID</th>
                <th>権限</th>
                <th>状態</th>
                <th>財布</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.id} className={m.active ? "" : "row-muted"}>
                  <td>{m.name}</td>
                  <td className="mono">{m.login_id}</td>
                  <td>
                    <div className="chips">
                      {m.roles.map((r) => (
                        <Badge key={r} tone={r === "admin" ? "danger" : r === "display" ? "info" : "neutral"}>
                          {roleLabel[r] ?? r}
                        </Badge>
                      ))}
                      {m.roles.length === 0 && <span className="muted">なし</span>}
                    </div>
                  </td>
                  <td>{m.active ? <Badge tone="ok">有効</Badge> : <Badge tone="neutral">無効</Badge>}</td>
                  <td>{m.wallet_account_id ? "あり" : "—"}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => setEditing(m)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <EditMember m={editing} onClose={() => setEditing(null)} run={run} reload={members.reload} />}
      <CreateMember run={run} reload={members.reload} />
      <CashAccounts run={run} members={members.data ?? []} />
      {ui}
    </AdminPage>
  );
}

function RolePicker({ value, onChange, lockAdmin }: { value: string[]; onChange: (v: string[]) => void; lockAdmin?: boolean }) {
  return (
    <div className="check-list">
      {ROLES.map((r) => (
        <label key={r} className="check">
          <input
            type="checkbox"
            checked={value.includes(r)}
            disabled={lockAdmin && r === "admin"}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
          />
          <span>
            {roleLabel[r]}
            <span className="help">{roleHelp[r]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function EditMember({ m, onClose, run, reload }: { m: Member; onClose: () => void; run: Run; reload: () => Promise<void> }) {
  const me = useStaff();
  const self = me?.id === m.id;
  const [name, setName] = useState(m.name);
  const [roles, setRoles] = useState<string[]>(m.roles);
  const [password, setPassword] = useState("");
  const rolesChanged = [...roles].sort().join() !== [...m.roles].sort().join();

  return (
    <Modal open onClose={onClose} title={`部員の編集：${m.name}`}>
      <label className="field">
        <span className="label">名前</span>
        <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span className="label">権限（複数選択可）</span>
        <RolePicker value={roles} onChange={setRoles} lockAdmin={self} />
        {self && <span className="help">自分自身の管理者権限は外せません。</span>}
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <ActionButton
          className="btn btn-primary"
          disabled={!name.trim() || (name === m.name && !rolesChanged)}
          confirm={rolesChanged ? `権限を「${roles.map((r) => roleLabel[r]).join("・") || "なし"}」に変更します。よろしいですか？` : undefined}
          onClick={async () => {
            const ok = await run(async () => {
              await patch(`/admin/members/${m.id}`, { name: name.trim(), ...(rolesChanged ? { roles } : {}) });
              await reload();
            }, "保存しました");
            if (ok) onClose();
          }}
        >
          名前・権限を保存
        </ActionButton>
      </div>
      <hr />
      <h3>パスワードの再設定</h3>
      <div className="row">
        <label className="grow">
          <span className="label">新しいパスワード（8文字以上）</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ActionButton
          className="btn"
          disabled={password.length < 8}
          confirm={`${m.name}さんのパスワードを再設定します。ログイン中の端末はすべてログアウトされます。よろしいですか？`}
          onClick={async () => {
            const ok = await run(async () => {
              await patch(`/admin/members/${m.id}`, { password });
              setPassword("");
            }, "パスワードを再設定しました");
            if (ok) onClose();
          }}
        >
          再設定
        </ActionButton>
      </div>
      <hr />
      <h3>アカウントの状態</h3>
      <p className="help">無効にするとログインできなくなり、ログイン中の端末もログアウトされます。操作履歴は残ります。</p>
      <ActionButton
        className={m.active ? "btn btn-danger" : "btn btn-ok"}
        disabled={self && m.active}
        confirm={m.active ? `${m.name}さんのアカウントを無効にします。よろしいですか？` : undefined}
        onClick={async () => {
          const ok = await run(async () => {
            await patch(`/admin/members/${m.id}`, { active: !m.active });
            await reload();
          }, m.active ? "無効にしました" : "有効にしました");
          if (ok) onClose();
        }}
      >
        {m.active ? "アカウントを無効にする" : "アカウントを有効に戻す"}
      </ActionButton>
      {self && <span className="help">自分自身は無効にできません。</span>}
    </Modal>
  );
}

function CreateMember({ run, reload }: { run: Run; reload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<string[]>(["member"]);
  const [wallet, setWallet] = useState(true);
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>部員を追加</h2>
      <div className="form-grid">
        <label>
          <span className="label">名前</span>
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="label">ログインID</span>
          <input value={loginId} maxLength={50} autoComplete="off" onChange={(e) => setLoginId(e.target.value)} />
        </label>
        <label>
          <span className="label">初期パスワード（8文字以上）</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <div className="field">
        <span className="label">権限</span>
        <RolePicker value={roles} onChange={setRoles} />
      </div>
      <label className="check">
        <input type="checkbox" checked={wallet} onChange={(e) => setWallet(e.target.checked)} />
        この部員の財布（現金保管先）を作成する
      </label>
      <span className="help">表示端末用アカウントでは財布は不要です。</span>
      <div style={{ marginTop: 8 }}>
        <ActionButton
          className="btn btn-primary"
          disabled={!name.trim() || !loginId.trim() || password.length < 8}
          onClick={() =>
            run(async () => {
              await post("/admin/members", { name: name.trim(), login_id: loginId.trim(), password, roles, create_wallet: wallet });
              setName("");
              setLoginId("");
              setPassword("");
              setRoles(["member"]);
              setWallet(true);
              await reload();
            }, "部員を追加しました")
          }
        >
          追加
        </ActionButton>
      </div>
    </section>
  );
}

function CashAccounts({ run, members }: { run: Run; members: Member[] }) {
  const accounts = useFetch<{ accounts: CashAccount[] }>("/staff/cash/accounts");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("register");
  const [memberId, setMemberId] = useState("");
  const [renaming, setRenaming] = useState<CashAccount | null>(null);
  const [newName, setNewName] = useState("");

  return (
    <section>
      <h2>現金保管先</h2>
      <p className="help">
        金庫・共用レジ・部員の財布を管理します。残高のある保管先は無効化できません（先に回収してください）。無効化した保管先はこの一覧に表示されません。
      </p>
      <ErrorBox error={accounts.error} />
      {accounts.data?.accounts.length === 0 && <Empty>保管先がありません</Empty>}
      {accounts.data && accounts.data.accounts.length > 0 && (
        <div className="table-wrap card">
          <table className="compact">
            <thead>
              <tr>
                <th>名前</th>
                <th>種類</th>
                <th>持ち主</th>
                <th className="num">現金残高</th>
                <th className="num">金券残高</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.data.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{accountKindLabel[a.kind] ?? a.kind}</td>
                  <td>{a.member_name ?? "—"}</td>
                  <td className="num">{yen(a.cash_balance)}</td>
                  <td className="num">{yen(a.voucher_balance)}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setNewName(a.name);
                          setRenaming(a);
                        }}
                      >
                        名前変更
                      </button>
                      <ActionButton
                        className="btn btn-sm btn-ghost"
                        confirm={`「${a.name}」を無効化します。よろしいですか？`}
                        onClick={() =>
                          run(async () => {
                            await patch(`/admin/cash/accounts/${a.id}`, { active: false });
                            await accounts.reload();
                          }, "無効化しました")
                        }
                      >
                        無効化
                      </ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {renaming && (
        <Modal open onClose={() => setRenaming(null)} title="保管先の名前変更">
          <label className="field">
            <span className="label">名前</span>
            <input value={newName} maxLength={50} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setRenaming(null)}>
              やめる
            </button>
            <ActionButton
              className="btn btn-primary"
              disabled={!newName.trim()}
              onClick={async () => {
                const ok = await run(async () => {
                  await patch(`/admin/cash/accounts/${renaming.id}`, { name: newName.trim() });
                  await accounts.reload();
                }, "名前を変更しました");
                if (ok) setRenaming(null);
              }}
            >
              保存
            </ActionButton>
          </div>
        </Modal>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>保管先を追加</h3>
        <div className="form-grid">
          <label>
            <span className="label">種類</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="safe">金庫（責任者管理）</option>
              <option value="register">共用レジ</option>
              <option value="wallet">部員の財布</option>
            </select>
          </label>
          <label>
            <span className="label">名前</span>
            <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="例：プラネ物販レジ" />
          </label>
          {kind === "wallet" && (
            <label>
              <span className="label">持ち主</span>
              <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">選択してください</option>
                {members
                  .filter((m) => m.active && !m.wallet_account_id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
              <span className="help">財布は1人1つまで（財布のない部員のみ表示）</span>
            </label>
          )}
          <div>
            <ActionButton
              className="btn btn-primary"
              disabled={!name.trim() || (kind === "wallet" && !memberId)}
              onClick={() =>
                run(async () => {
                  await post("/admin/cash/accounts", { name: name.trim(), kind, member_id: kind === "wallet" ? memberId : "" });
                  setName("");
                  setMemberId("");
                  await accounts.reload();
                }, "保管先を追加しました")
              }
            >
              追加
            </ActionButton>
          </div>
        </div>
      </div>
    </section>
  );
}
