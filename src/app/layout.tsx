import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "File MCP · Google Drive",
  description: "Folder-scoped Google Drive tools for agent-bot",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
