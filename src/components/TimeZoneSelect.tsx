import { useMemo } from "react";
import { browserTimeZone, DEFAULT_TIME_ZONE, useDisplayTimeZone } from "../timeZone";
import "./TimeZoneSelect.css";

const COMMON_ZONES = [
  "America/Anchorage", "America/Chicago", "America/Denver", "America/New_York",
  "America/Phoenix", "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney", "Europe/Berlin", "Europe/London", "Pacific/Honolulu",
];
const PRIMARY_ZONES = new Set([DEFAULT_TIME_ZONE, "UTC", "Etc/GMT+8"]);

export function TimeZoneSelect({ compact = false }: { compact?: boolean }) {
  const { preference, setTimeZone } = useDisplayTimeZone();
  const zones = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone") : COMMON_ZONES;
    return [...new Set([...supported, ...(preference === "system" ? [] : [preference])])]
      .filter((zone) => !PRIMARY_ZONES.has(zone)).sort();
  }, [preference]);

  return (
    <label className={`time-zone-select${compact ? " time-zone-select-compact" : ""}`}>
      <span>Time zone</span>
      <select
        aria-label="Display time zone"
        title="Applies to all dates and times in this browser"
        value={preference}
        onChange={(event) => setTimeZone(event.target.value)}
      >
        <option value={DEFAULT_TIME_ZONE}>Pacific (PST / PDT)</option>
        <option value="UTC">UTC</option>
        <option value="system">Browser ({browserTimeZone().replaceAll("_", " ")})</option>
        <option value="Etc/GMT+8">Fixed PST (UTC−08:00)</option>
        <optgroup label="Other time zones">
          {zones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
        </optgroup>
      </select>
    </label>
  );
}
