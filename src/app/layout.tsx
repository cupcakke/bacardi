import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nested — Your agents. One direction.",
  description: "The workspace for hierarchical agent orchestration. Plan deliberately, run work in parallel, and retain every handoff.",
};
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
