import { redirect } from "next/navigation";

// The project's landing page lives in a separate repo. This app's root just
// sends visitors to the tool.
export default function Home() {
  redirect("/app");
}
