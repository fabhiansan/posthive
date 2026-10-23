"use client";

// 24-hour "HH:MM" input — native <input type="time"> follows the OS locale and can show AM/PM.

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

interface Props {
  value: string; // "HH:MM"
  onChange: (v: string) => void;
  style?: React.CSSProperties;
}

export function TimeInput24({ value, onChange, style }: Props) {
  const [h = "09", m = "00"] = value.split(":");
  const selectStyle: React.CSSProperties = {
    flex: 1, backgroundColor: "#111", border: "1px solid #2a2a2a", borderRadius: 7,
    padding: "6px 8px", fontSize: 12, color: "#ededed", outline: "none", colorScheme: "dark",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, ...style }}>
      <select value={h} onChange={(e) => onChange(`${e.target.value}:${m}`)} style={selectStyle} aria-label="Hour">
        {HOURS.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <span style={{ color: "#555", fontSize: 12 }}>:</span>
      <select value={m} onChange={(e) => onChange(`${h}:${e.target.value}`)} style={selectStyle} aria-label="Minute">
        {MINUTES.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}
