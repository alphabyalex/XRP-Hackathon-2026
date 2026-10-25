"use client";
// /borrow#apply: the two request flows (POST /applications). "capital" is a
// borrower asking for access to capital; "market" is a GPU operator asking
// for a vault to fund their GPUs.
import { useState } from "react";
import { submitApplication, type ApplicationKind } from "@/lib/lendingApi";
import { Segmented } from "../Segmented";
import { Button } from "../Button";

const KINDS: { value: ApplicationKind; label: string }[] = [
  { value: "capital", label: "Request access to capital" },
  { value: "market", label: "List a market" },
];

const COPY: Record<ApplicationKind, { lede: string; company: string; details: string; placeholder: string }> = {
  capital: {
    lede: "For funds and firms that want to borrow against GPU shares at size.",
    company: "Firm",
    details: "How much, against which GPUs, and for how long",
    placeholder: "For example: 250,000 USDC over 90 days against GPU-A and GPU-B shares.",
  },
  market: {
    lede: "For GPU operators who want a lending round to finance their GPUs.",
    company: "Operator",
    details: "Your GPUs: model, count, power, location, and what you need financed",
    placeholder: "For example: 64x H100, 0.9 MW, Frankfurt. 1.2M USDC to expand the cluster.",
  },
};

export function Apply() {
  const [kind, setKind] = useState<ApplicationKind>("capital");
  const [f, setF] = useState({ name: "", email: "", company: "", details: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; status: string; kind: ApplicationKind } | null>(null);
  const c = COPY[kind];
  const ok = f.name.trim() && /.+@.+\..+/.test(f.email) && f.details.trim().length >= 10;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await submitApplication({ kind, name: f.name.trim(), email: f.email.trim(), company: f.company.trim() || undefined, details: f.details.trim() });
      setDone({ id: r.id, status: r.status, kind });
    } catch (e) {
      const m = (e as Error).message;
      setErr(/404|not found/i.test(m) ? "Requests are not open right now. Please try again shortly." : m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="apply" className="bw-apply trade card">
      <div className="bw-apply-head">
        <div>
          <h3 className="sub-h" style={{ margin: 0 }}>
            Work with Moonshift
          </h3>
          <p className="note" style={{ marginTop: 6 }}>
            {c.lede}
          </p>
        </div>
        <Segmented
          options={KINDS}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setDone(null);
            setErr(null);
          }}
        />
      </div>
      {done ? (
        <div className="bw-apply-done">
          <div className="bw-apply-status">
            <span>Status</span>
            <b>Under review</b>
            <span className="mdl-id">Reference {done.id}</span>
          </div>
          <p>
            A Moonshift analyst reviews every request: KYC, signed agreements such as ISDAs, and GPU verification. Approved participants and markets
            are funded, and their GPUs are tokenized as real-world assets.
          </p>
        </div>
      ) : (
        <form className="bw-apply-form" onSubmit={submit}>
          <label>
            <span className="lbl">Name</span>
            <input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
          </label>
          <label>
            <span className="lbl">Email</span>
            <input className="field" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
          </label>
          <label>
            <span className="lbl">{c.company}</span>
            <input className="field" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoComplete="organization" />
          </label>
          <label className="wide">
            <span className="lbl">{c.details}</span>
            <textarea className="field" rows={3} placeholder={c.placeholder} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
          </label>
          <div className="wide bw-apply-foot">
            {err ? <span className="note dn">{err}</span> : <span className="note">An analyst replies by email.</span>}
            <Button type="submit" disabled={!ok || busy}>{busy ? "Sending..." : kind === "capital" ? "Request access" : "Submit market"}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
