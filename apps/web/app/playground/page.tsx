import { redirect } from "next/navigation";

// The developer playground lives on Models now (try a model, the OpenAI-compatible API).
export default function PlaygroundPage() {
  redirect("/models");
}
