import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Nfc, X, Package } from 'lucide-react';
import { api, type InventorySpool } from '../api/client';
import { normalizeHexTag, uidMatches, isNfcModalSuppressed } from '../utils/nfc';

type NfcStatus = 'unsupported' | 'off' | 'idle' | 'scanning' | 'permission-needed' | 'error';

interface NfcReadView {
  serialNumber: string;
  readAt: number;
}

interface NdefReadingEventLike {
  serialNumber?: string;
}

interface NdefReaderLike {
  scan: (options?: { signal?: AbortSignal }) => Promise<void>;
  onreading: ((event: NdefReadingEventLike) => void) | null;
  onreadingerror: (() => void) | null;
}

interface NdefReaderConstructorLike {
  new (): NdefReaderLike;
}


function SpoolCircle({ color, size = 64 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="shrink-0">
      <circle cx="32" cy="32" r="30" fill={color} />
      <circle cx="32" cy="32" r="22" fill={color} style={{ filter: 'brightness(0.82)' }} />
      <ellipse cx="23" cy="23" rx="7" ry="5" fill="white" opacity="0.25" />
      <circle cx="32" cy="32" r="9" fill="#27272a" />
      <circle cx="32" cy="32" r="5.5" fill="#18181b" />
    </svg>
  );
}

export function WebNfcListener() {
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<NfcStatus>('idle');
  const [lastRead, setLastRead] = useState<NfcReadView | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const navigate = useNavigate();

  const { data: spools = [] } = useQuery({
    queryKey: ['inventory-spools', 'web-nfc-listener'],
    queryFn: () => api.getSpools(false),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  const matchedSpool = useMemo<InventorySpool | null>(() => {
    if (!lastRead) return null;
    return spools.find((spool) => uidMatches(lastRead.serialNumber, spool.tag_uid)) ?? null;
  }, [lastRead, spools]);

  const readerRef = useRef<NdefReaderLike | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startScanRef = useRef<(() => Promise<void>) | null>(null);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    readerRef.current = null;
    setStatus('off');
    setIsModalOpen(false);
  }, []);

  const startScan = useCallback(async () => {
    const ReaderCtor = (window as unknown as { NDEFReader?: NdefReaderConstructorLike }).NDEFReader;
    if (!ReaderCtor) {
      setStatus('unsupported');
      return;
    }

    try {
      abortRef.current?.abort();
      const abortController = new AbortController();
      abortRef.current = abortController;

      const reader = new ReaderCtor();
      reader.onreading = (event) => {
        setLastRead({
          serialNumber: normalizeHexTag(event.serialNumber) || 'unknown',
          readAt: Date.now(),
        });
        if (!isNfcModalSuppressed()) {
          setIsModalOpen(true);
        }
      };
      reader.onreadingerror = null;

      await reader.scan({ signal: abortController.signal });
      readerRef.current = reader;
      setStatus('scanning');
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('permission-needed');
        return;
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    startScanRef.current = startScan;
  }, [startScan]);

  useEffect(() => {
    if (enabled) {
      void startScan();
    } else {
      stopScan();
    }

    const onVisibilityChange = () => {
      if (enabled && document.visibilityState === 'visible') {
        void startScanRef.current?.();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      abortRef.current?.abort();
      abortRef.current = null;
      readerRef.current = null;
    };
  }, [enabled, startScan, stopScan]);

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => !prev);
  }, []);

  const statusText = useMemo(() => {
    if (status === 'off') return 'NFC off';
    if (status === 'scanning') return 'NFC active';
    if (status === 'permission-needed') return 'NFC permission required';
    if (status === 'unsupported') return 'Web NFC not supported';
    if (status === 'error') return 'NFC error';
    return 'NFC idle';
  }, [status]);

  if (status === 'unsupported') {
    return null;
  }

  const spoolColor = matchedSpool?.rgba ? `#${matchedSpool.rgba.slice(0, 6)}` : '#71717a';
  const remaining = matchedSpool
    ? Math.max(0, Math.round(matchedSpool.label_weight - (matchedSpool.weight_used || 0)))
    : 0;
  const pct = matchedSpool && matchedSpool.label_weight > 0
    ? Math.min(100, Math.round((remaining / matchedSpool.label_weight) * 100))
    : 0;
  const fillColor = pct > 50 ? '#22c55e' : pct > 20 ? '#eab308' : '#ef4444';

  return (
    <>
      <button
        type="button"
        aria-label={enabled ? 'Disable NFC scanning' : 'Enable NFC scanning'}
        title={enabled ? 'Click to disable NFC scanning' : 'Click to enable NFC scanning'}
        onClick={toggleEnabled}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-bambu-dark-secondary/90 px-3 py-2 text-xs text-bambu-gray-light shadow-lg backdrop-blur-sm transition-colors hover:bg-bambu-dark"
      >
        <Nfc className={`h-4 w-4 ${status === 'scanning' ? 'text-bambu-green animate-nfc-breathe' : 'text-bambu-gray'}`} />
        <span>{statusText}</span>
      </button>

      {isModalOpen && lastRead && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={closeModal}
        >
          <div
            className="bg-zinc-800 rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-bambu-green/15 flex items-center justify-center">
                  <Nfc className="h-4 w-4 text-bambu-green" />
                </div>
                <h3 className="text-base font-semibold text-white">
                  {matchedSpool ? 'Spool Detected' : 'NFC Tag Read'}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close NFC modal"
                onClick={closeModal}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 pb-5 space-y-4">
              {matchedSpool ? (
                <>
                  {/* Spool visual + main info */}
                  <div className="flex items-center gap-4">
                    <SpoolCircle color={spoolColor} size={64} />
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold text-zinc-100 leading-tight">
                        {matchedSpool.color_name || 'Unknown color'}
                      </p>
                      <p className="text-sm text-zinc-400 mt-0.5">
                        {[matchedSpool.brand, matchedSpool.material, matchedSpool.subtype].filter(Boolean).join(' · ')}
                      </p>
                      {/* Remaining bar */}
                      <div className="mt-2.5">
                        <div className="flex items-baseline gap-1.5 mb-1">
                          <span className="text-lg font-bold font-mono text-zinc-100">{remaining}g</span>
                          <span className="text-xs text-zinc-500">/ {matchedSpool.label_weight}g</span>
                          <span className="text-xs font-medium ml-auto" style={{ color: fillColor }}>{pct}%</span>
                        </div>
                        <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, backgroundColor: fillColor }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Tag UID */}
                  <div className="flex items-center justify-between bg-zinc-900/60 rounded-xl px-4 py-2.5">
                    <span className="text-xs text-zinc-500 uppercase tracking-wide">Tag UID</span>
                    <span className="font-mono text-xs text-zinc-400">{lastRead.serialNumber}</span>
                  </div>
                </>
              ) : (
                <>
                  {/* Unknown tag */}
                  <div className="flex flex-col items-center py-2 gap-2">
                    <div className="w-14 h-14 rounded-2xl bg-zinc-700/60 flex items-center justify-center">
                      <Nfc className="w-7 h-7 text-zinc-500" />
                    </div>
                    <p className="text-xs text-zinc-500">No spool linked to this tag</p>
                  </div>
                  <div className="flex items-center justify-between bg-zinc-900/60 rounded-xl px-4 py-2.5">
                    <span className="text-xs text-zinc-500 uppercase tracking-wide">Tag UID</span>
                    <span className="font-mono text-xs text-zinc-400">{lastRead.serialNumber}</span>
                  </div>
                </>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                {matchedSpool && (
                  <button
                    type="button"
                    onClick={() => {
                      closeModal();
                      navigate(`/inventory?spool=${matchedSpool.id}`);
                    }}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-bambu-green text-white hover:bg-bambu-green/90 transition-colors"
                  >
                    <Package className="h-4 w-4" />
                    Go to Inventory
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
