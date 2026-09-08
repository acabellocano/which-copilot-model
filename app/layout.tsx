import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Which Copilot Model?",
  description: "Compare VS Code model availability with DeepSWE benchmark results."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
