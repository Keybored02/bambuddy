/**
 * Animated NFC icon — four arcs that pulse sequentially left-to-right
 * when `scanning` is true, mimicking radio wave emission.
 * When not scanning, renders identically to the Lucide Nfc icon (static).
 */

interface NfcIconProps {
  className?: string;
  size?: number;
  scanning?: boolean;
}

// Arc paths from lucide-react Nfc icon (v0.555.0)
// Ordered innermost → outermost (left → right)
const ARCS = [
  "M6 8.32a7.43 7.43 0 0 1 0 7.36",
  "M9.46 6.21a11.76 11.76 0 0 1 0 11.58",
  "M12.91 4.1a15.91 15.91 0 0 1 .01 15.8",
  "M16.37 2a20.16 20.16 0 0 1 0 20",
];

export function NfcIcon({ className = '', size = 24, scanning = false }: NfcIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ARCS.map((d, i) => (
        <path
          key={i}
          d={d}
          style={scanning ? {
            animation: `nfc-wave 1.6s ease-in-out infinite`,
            animationDelay: `${i * 0.18}s`,
          } : undefined}
        />
      ))}
    </svg>
  );
}
