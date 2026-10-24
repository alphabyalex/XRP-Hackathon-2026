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
    <div className={clsx("seg", idx === 1 && "r")}>
      <span className="thumb" />
      {options.map((o) => (
        <button key={o.value} type="button" className={clsx(o.value === value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
