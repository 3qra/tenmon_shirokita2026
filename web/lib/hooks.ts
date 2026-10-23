"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";

/**
 * useLive: データを取得し、SSEの変更通知で再取得する。
 * - 通知は「変わったかもしれない」合図。受信したら必ずAPIで最新状態を取り直す。
 * - 切断時は自動再接続し、再接続時にも全件再取得する。
 * - SSEが使えない環境でも pollMs ごとに再取得する。
 * - lastOk / stale で「最終更新」と通信断を画面に明示できる。
 */
export function useLive<T>(path: string | null, topics: string[], pollMs = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [lastOk, setLastOk] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const topicKey = topics.join(",");

  const reload = useCallback(async () => {
    if (!path) return;
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    try {
      const d = await get<T>(path, ac.signal);
      setData(d);
      setError(null);
      setLastOk(new Date());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e as Error);
    }
  }, [path]);

  useEffect(() => {
    reload();
    if (!path) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 150);
    };
    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/v1/events?topics=${encodeURIComponent(topicKey)}`);
      es.addEventListener("hello", () => {
        setConnected(true);
        reload(); // 再接続時は全件再取得
      });
      es.addEventListener("change", debounced);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    if (topicKey) connect();
    const poll = setInterval(reload, pollMs);
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reload);
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reload);
      inflight.current?.abort();
    };
  }, [path, topicKey, pollMs, reload]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const stale = !!lastOk && now - lastOk.getTime() > Math.max(pollMs * 2, 30000);

  return { data, error, reload, lastOk, connected, stale, setData };
}

/** 一度だけ取得する */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
