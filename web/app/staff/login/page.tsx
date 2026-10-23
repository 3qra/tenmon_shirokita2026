"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { errorMessage, post } from "@/lib/api";
import { ErrorBox } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/staff";

  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <h1>スタッフログイン</h1>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post("/auth/login", { login_id: loginId, password });
            router.replace(safeNext);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="label">ログインID</span>
          <input value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoCapitalize="none" required />
        </label>
        <label className="field">
          <span className="label">パスワード</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-block" disabled={busy} type="submit">
          {busy ? "確認中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
