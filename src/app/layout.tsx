import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BRAND, SITE_TITLE, SITE_DESCRIPTION } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: `%s — ${BRAND.name}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: BRAND.name,
  icons: {
    icon: "/favicon.svg",
  },
  // The app is a tool, not a marketing surface: the project's landing page (a
  // separate repo) owns SEO and social cards. Keep the app out of search indexes.
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: next-themes (mounted in the /app segment only)
    // sets the theme class + color-scheme on <html> before hydration, which
    // would otherwise trip a mismatch warning here.
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
