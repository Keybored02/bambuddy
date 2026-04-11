import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Nfc, X, Package } from 'lucide-react';
import { api, type InventorySpool } from '../api/client';

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

const MODAL_AUTO_HIDE_MS = 8000;

function normalizeHexTag(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

function normalizeTagUid(value: string | null | undefined): string {
  const uid = normalizeHexTag(value);
  if (uid.length > 16) {
    return uid.slice(-16);
  }
  return uid;
}

function isZeroHex(value: string): boolean {
  return value.length > 0 && /^0+$/.test(value);
}

function uidMatches(scannedUid: string | null | undefined, storedUid: string | null | undefined): boolean {
  const scanned = normalizeTagUid(scannedUid);
  const stored = normalizeTagUid(storedUid);

  if (!scanned || !stored || isZeroHex(scanned) || isZeroHex(stored)) {
    return false;
  }

  if (scanned === stored) {
    return true;
  }

  if (stored.length > scanned.length && stored.endsWith(scanned)) {
    return true;
  }

  if (scanned.length > stored.length && scanned.endsWith(stored)) {
    return true;
  }

  if (scanned.length >= 8 && stored.endsWith(scanned.slice(-8))) {
    return true;
  }

  if (scanned.length === stored.length && scanned.length > 1 && scanned.slice(1) === stored.slice(1)) {
    return true;
  }

  if (scanned.length === 8 && stored.length >= 8 && scanned.slice(1) === stored.slice(0, 8).slice(1)) {
    return true;
  }

  return false;
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
    if (!lastRead) {
      return null;
    }

    return spools.find((spool) => uidMatches(lastRead.serialNumber, spool.tag_uid)) ?? null;
  }, [lastRead, spools]);

  const readerRef = useRef<NdefReaderLike | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const startScanRef = useRef<(() => Promise<void>) | null>(null);

  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const closeModal = useCallback(() => {
    clearHideTimeout();
    setIsModalOpen(false);
  }, [clearHideTimeout]);

  const scheduleAutoHide = useCallback(() => {
    clearHideTimeout();
    hideTimeoutRef.current = window.setTimeout(() => {
      setIsModalOpen(false);
    }, MODAL_AUTO_HIDE_MS);
  }, [clearHideTimeout]);

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    readerRef.current = null;
    setStatus('off');
    setIsModalOpen(false);
    clearHideTimeout();
  }, [clearHideTimeout]);

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
        setIsModalOpen(true);
        scheduleAutoHide();
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
  }, [scheduleAutoHide]);

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
      clearHideTimeout();
      abortRef.current?.abort();
      abortRef.current = null;
      readerRef.current = null;
    };
  }, [clearHideTimeout, enabled, startScan, stopScan]);

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

  return (
    <>
      <button
        type="button"
        aria-label={enabled ? 'Disable NFC scanning' : 'Enable NFC scanning'}
        title={enabled ? 'Click to disable NFC scanning' : 'Click to enable NFC scanning'}
        onClick={toggleEnabled}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-bambu-dark-secondary/90 px-3 py-2 text-xs text-bambu-gray-light shadow-lg backdrop-blur-sm transition-colors hover:bg-bambu-dark"
      >
        <Nfc className={`h-4 w-4 ${status === 'scanning' ? 'text-status-ok' : 'text-bambu-gray'}`} />
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
              {/* Tag UID */}
              <div className="flex items-center justify-between bg-zinc-900/60 rounded-xl px-4 py-3">
                <span className="text-xs text-zinc-500 uppercase tracking-wide">Tag UID</span>
                <span className="font-mono text-xs text-zinc-300">{lastRead.serialNumber}</span>
              </div>

              {/* Matched spool info */}
              {matchedSpool ? (
                <div className="rounded-xl border border-bambu-green/30 bg-bambu-green/10 px-4 py-3 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-bambu-green">Matched Spool</p>
                  <p className="text-sm font-semibold text-zinc-100">
                    {matchedSpool.brand ? `${matchedSpool.brand} ` : ''}
                    {matchedSpool.material}
                    {matchedSpool.subtype ? ` ${matchedSpool.subtype}` : ''}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {matchedSpool.color_name || 'Unknown color'}
                    {typeof matchedSpool.label_weight === 'number'
                      ? ` · ${Math.max(0, Math.round(matchedSpool.label_weight - (matchedSpool.weight_used || 0)))}g remaining`
                      : ''}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl bg-zinc-900/60 px-4 py-3 text-xs text-zinc-500 text-center">
                  No spool linked to this tag
                </div>
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
