import type { ReactNode } from "react";

import "./ui.css";

export const metadata = {
  title: "{{PROJECT_NAME}}",
  description: "Built with Heyo CMS.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/home.css" />
        <script src="/home.js" defer />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
