import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { LiveDataProvider } from "@/lib/liveData";
import { MarketContent } from "@/components/MarketContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

export default async function MarketPage() {
  const { gpus, unreachable } = await fetchAllGpus();

  if (unreachable) {
    return (
      <main className="wrap" style={{ paddingBlock: 120 }}>
        <ApiErrorNotice />
      </main>
    );
  }

  return (
    <LiveDataProvider initial={gpus} initialNow={Date.now()}>
      <MarketContent />
    </LiveDataProvider>
  );
}
