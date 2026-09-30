import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Which Copilot Model? · Decision Desk",
  description: "Bring your VS Code model inventory, compare independent coding evidence, and build a transparent quality or credit-value shortlist."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
