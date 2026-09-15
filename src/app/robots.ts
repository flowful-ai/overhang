import type { MetadataRoute } from "next";

// The app is a tool, not a marketing surface: the project's landing page (a
// separate repo) owns SEO. Keep the app out of search indexes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
