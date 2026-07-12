export function AdsoluteMark({
  size = 20,
  className,
  adaptive = false,
}: {
  size?: number;
  className?: string;
  /** Swap the dark olive tile to a light fill in dark mode. Use only on theme-following surfaces, not fixed-color chips. */
  adaptive?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 360 360"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        width="168"
        height="168"
        rx="38"
        className={
          adaptive ? "fill-[#333d2a] dark:fill-[#d8e3c2]" : "fill-[#333d2a]"
        }
      />
      <rect x="192" width="168" height="168" rx="38" fill="#8a9b6e" />
      <rect y="192" width="168" height="168" rx="38" fill="#c9c2b0" />
      <rect x="192" y="192" width="168" height="168" rx="38" fill="#ff5c1f" />
    </svg>
  );
}
