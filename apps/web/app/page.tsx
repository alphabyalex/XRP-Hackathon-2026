import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { LiveDataProvider } from "@/lib/liveData";
import { HomeContent } from "@/components/HomeContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

export default async function LandingPage() {
  const { gpus, unreachable } = await fetchAllGpus();

  if (unreachable) {
    return (
      <main className="wrap" style={{ paddingBlock: 120 }}>
        <ApiErrorNotice />
      </main>
    );
  }

  return (
    <LiveDataProvider initial={gpus}>
      <HomeContent />
    </LiveDataProvider>
  );
}
