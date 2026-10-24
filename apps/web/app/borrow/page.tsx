import { getPortfolio, ApiUnreachableError } from "@/lib/api";
import { fetchAllGpus } from "@/lib/fetchAllGpus";
import { ACCOUNT } from "@/lib/session";
import { BorrowContent } from "@/components/BorrowContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

export default async function BorrowPage() {
  try {
    const [portfolio, { gpus }] = await Promise.all([getPortfolio(ACCOUNT), fetchAllGpus()]);
    const gpu = gpus["gpu-a"] ?? Object.values(gpus)[0];
    return <BorrowContent initialPortfolio={portfolio} gpuId={gpu.id} gpuLabel={gpu.id.toUpperCase()} sharePrice={Number(gpu.sharePrice) || 0} />;
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
