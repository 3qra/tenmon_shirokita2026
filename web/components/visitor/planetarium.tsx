"use client";

import { Badge } from "@/components/ui";

export const symbolText: Record<string, string> = {
  "○": "空席あり",
  "△": "残りわずか",
  "×": "満席",
};

export function SeatSymbol({ symbol, cancelled }: { symbol: string; cancelled?: boolean }) {
  if (cancelled) {
    return (
      <span className="symbol" aria-label="上映中止" style={{ color: "var(--danger)" }}>
        ―
      </span>
    );
  }
  return (
    <span className="symbol" aria-label={symbolText[symbol] ?? symbol} title={symbolText[symbol]}>
      {symbol}
    </span>
  );
}

export function SymbolLegend() {
  return (
    <div className="v-legend" aria-label="空席記号の見かた">
      <span>
        <b>○</b> 空席あり
      </span>
      <span>
        <b>△</b> 残りわずか
      </span>
      <span>
        <b>×</b> 満席
      </span>
    </div>
  );
}

/** 事前予約と当日参加の可否を別々に表示する */
export function AvailabilityBadges({ advanceOk, walkinOk }: { advanceOk: boolean; walkinOk: boolean }) {
  return (
    <div className="v-avail">
      <Badge tone={advanceOk ? "ok" : "neutral"}>{advanceOk ? "✓ 事前予約できます" : "✕ 事前予約不可"}</Badge>
      <Badge tone={walkinOk ? "ok" : "neutral"}>{walkinOk ? "✓ 当日参加できます" : "✕ 当日参加不可"}</Badge>
    </div>
  );
}
