import type { Metadata } from "next";
import "./admin.css";

export const metadata: Metadata = { title: "管理" };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
