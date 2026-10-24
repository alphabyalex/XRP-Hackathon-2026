import { notFound } from "next/navigation";
import { GPUS } from "@moonshift/shared";
import { getGpu, ApiUnreachableError } from "@/lib/api";
import { LiveDataProvider } from "@/lib/liveData";
import { GpuDetailContent } from "@/components/GpuDetailContent";
import { ApiErrorNotice } from "@/components/ApiErrorNotice";

export async function generateStaticParams() {
  return GPUS.map((g) => ({ id: g.id }));
}

export default async function GpuDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!GPUS.some((g) => g.id === id)) notFound();

  try {
    const gpu = await getGpu(id);
    return (
      <LiveDataProvider initial={{ [gpu.id]: gpu }} initialNow={Date.now()}>
        <GpuDetailContent id={id} />
      </LiveDataProvider>
    );
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
