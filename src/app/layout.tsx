import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FaresMatch AI OS",
  description: "AI-powered Programmatic SEO, AEO, GEO & AI Visibility Operating System",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
