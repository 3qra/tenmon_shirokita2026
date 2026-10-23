"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage, post } from "@/lib/api";
import { useFetch } from "@/lib/hooks";
import { mdhm } from "@/lib/format";
import { ActionButton, Badge, Empty, ErrorBox } from "@/components/ui";
import { StaffShell } from "@/components/StaffShell";

type Notification = { id: string; kind: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string };

export default function NotificationsPage() {
  return (
    <StaffShell>
      <Notifications />
    </StaffShell>
  );
}

function Notifications() {
  const router = useRouter();
  const { data, error, reload, setData } = useFetch<Notification[]>("/staff/notifications");
  const [err, setErr] = useState<string | null>(null);
  const unread = (data ?? []).filter((n) => !n.read_at).length;

  async function open(n: Notification) {
    setErr(null);
    if (!n.read_at) {
      try {
        await post("/staff/notifications/read", { ids: [n.id] });
        setData((d) => (d ? d.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) : d));
      } catch (e) {
        setErr(errorMessage(e));
      }
    }
    // 内部リンクのみ遷移する
    if (n.link && n.link.startsWith("/") && !n.link.startsWith("//")) router.push(n.link);
  }

  return (
    <>
      <div className="section-title">
        <h1 style={{ margin: 0 }}>通知</h1>
        <div className="row">
          <button className="btn btn-sm" onClick={reload}>
            更新
          </button>
          <ActionButton
            className="btn btn-sm"
            disabled={unread === 0}
            onClick={async () => {
              setErr(null);
              try {
                await post("/staff/notifications/read", { all: true });
                await reload();
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            すべて既読にする
          </ActionButton>
        </div>
      </div>
      <p>未読 {unread}件</p>
      <ErrorBox error={error ?? err} />
      {data && data.length === 0 && <Empty>通知はありません</Empty>}
      {data?.map((n) => (
        <button key={n.id} className={`notif-item ${n.read_at ? "" : "unread"}`} onClick={() => open(n)}>
          <div className="row-between">
            <strong>{n.title}</strong>
            {n.read_at ? <Badge tone="neutral">既読</Badge> : <Badge tone="info">● 未読</Badge>}
          </div>
          {n.body && <p>{n.body}</p>}
          <small>
            {mdhm(n.created_at)}
            {n.link && "・タップで開く"}
          </small>
        </button>
      ))}
    </>
  );
}
