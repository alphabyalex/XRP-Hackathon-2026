import { getPortfolio, getTxLog, ApiUnreachableError } from "@/lib/api";
import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { ACCOUNT } from "@/lib/session";
import { PortfolioContent } from "@/components/PortfolioContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

export default async function PortfolioPage() {
  try {
    const [portfolio, txLog, { gpus }] = await Promise.all([getPortfolio(ACCOUNT), getTxLog(), fetchAllGpus()]);
    return <PortfolioContent initialPortfolio={portfolio} initialTxLog={txLog} gpus={gpus} />;
  } catch (err) {
    if (err instanceof ApiUnreachableError) {
      return (
        <main className="wrap" style={{ paddingBlock: 120 }}>
          <ApiErrorNotice />
        </main>
      );
    }
    throw err;
  }
}
