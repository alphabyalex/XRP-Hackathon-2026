"use client";
import clsx from "clsx";

export interface PickableSlot {
  index: number;
  label: string;
  booked: boolean;
}

// Ported from .slots / .slot in moonshift_v2_source.html. See BRAND.md
// "Slot picker".
export function SlotPicker({
  slots,
  selected,
  onToggle,
}: {
  slots: PickableSlot[];
  selected: Set<number>;
  onToggle: (index: number) => void;
}) {
  return (
    <div className="slots">
      {slots.map((s) => (
        <button
          key={s.index}
          type="button"
          className={clsx("slot", selected.has(s.index) && "sel")}
          disabled={s.booked}
          aria-pressed={selected.has(s.index)}
          onClick={() => onToggle(s.index)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
