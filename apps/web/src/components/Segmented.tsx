"use client";
import clsx from "clsx";

// Ported from .seg / .seg .thumb in moonshift_v2_source.html. Only supports
// two options (the reference's sliding thumb is a 50%-width translate).
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div className="seg" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span className="thumb" style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${Math.max(0, idx) * 100}%)` }} />
      {options.map((o) => (
        <button key={o.value} type="button" className={clsx(o.value === value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
