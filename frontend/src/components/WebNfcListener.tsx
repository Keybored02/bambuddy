import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Nfc, X, AlertTriangle } from 'lucide-react';

type NfcStatus = 'unsupported' | 'off' | 'idle' | 'scanning' | 'permission-needed' | 'error';

interface NfcRecordView {
  recordType: string;
  mediaType?: string;
  id?: string;
  payload: string;
  rawHex?: string;
  encoding?: string;
  lang?: string;
}

interface NfcReadView {
  serialNumber: string;
  records: NfcRecordView[];
  readAt: number;
}

interface NdefRecordLike {
  recordType?: string;
  mediaType?: string;
  id?: string;
  data?: unknown;
  encoding?: string;
  lang?: string;
}

interface NdefMessageLike {
  records?: NdefRecordLike[];
}

interface NdefReadingEventLike {
  serialNumber?: string;
  message?: NdefMessageLike;
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

function decodeRecordPayload(record: NdefRecordLike): string {
  const raw = record.data;
  if (!(raw instanceof DataView) && !(raw instanceof ArrayBuffer)) {
    return '-';
  }

  try {
    const dataView = raw instanceof DataView ? raw : new DataView(raw);
    const decoder = new TextDecoder(record.encoding || 'utf-8');
    const text = decoder.decode(dataView);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return '-';
    }
    return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
  } catch {
    return '[binary payload]';
  }
}

function toHexDump(raw: DataView | ArrayBuffer): string {
  const bytes = raw instanceof DataView
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : new Uint8Array(raw);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase();
}

function parseReadEvent(event: NdefReadingEventLike): NfcReadView {
  const records = (event.message?.records || []).map((record) => ({
    recordType: record.recordType || 'unknown',
    mediaType: record.mediaType,
    id: record.id,
    payload: decodeRecordPayload(record),
    rawHex: record.data instanceof DataView || record.data instanceof ArrayBuffer ? toHexDump(record.data) : undefined,
    encoding: record.encoding,
    lang: record.lang,
  }));

  return {
    serialNumber: normalizeHexTag(event.serialNumber) || 'unknown',
    records,
    readAt: Date.now(),
  };
}

export function WebNfcListener() {
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<NfcStatus>('idle');
  const [lastRead, setLastRead] = useState<NfcReadView | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    setErrorMessage(null);
    setIsModalOpen(false);
    clearHideTimeout();
  }, [clearHideTimeout]);

  const startScan = useCallback(async () => {
    const ReaderCtor = (window as unknown as { NDEFReader?: NdefReaderConstructorLike }).NDEFReader;
    if (!ReaderCtor) {
      setStatus('unsupported');
      setErrorMessage(null);
      return;
    }

    try {
      abortRef.current?.abort();
      const abortController = new AbortController();
      abortRef.current = abortController;

      const reader = new ReaderCtor();
      reader.onreading = (event) => {
        try {
          const parsed = parseReadEvent(event);
          setLastRead(parsed);
          setIsModalOpen(true);
          scheduleAutoHide();
        } catch (err) {
          // Always surface a modal for read events, even if parsing fails.
          const fallbackSerial = normalizeHexTag(event.serialNumber) || 'unknown';
          setLastRead({
            serialNumber: fallbackSerial,
            records: [],
            readAt: Date.now(),
          });
          setErrorMessage(err instanceof Error ? err.message : 'Failed to parse NFC read payload.');
          setIsModalOpen(true);
          scheduleAutoHide();
        }
      };
      reader.onreadingerror = () => {
        setErrorMessage('NFC tag detected, but payload was not readable as NDEF.');
        // readingerror can happen for non-NDEF / unsupported formatting. Show a modal hint.
        setLastRead((prev) => prev ?? {
          serialNumber: 'unknown',
          records: [],
          readAt: Date.now(),
        });
        setIsModalOpen(true);
        scheduleAutoHide();
      };

      await reader.scan({ signal: abortController.signal });
      readerRef.current = reader;
      setStatus('scanning');
      setErrorMessage(null);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('permission-needed');
        setErrorMessage('Tap "Enable NFC" to grant browser permission.');
        return;
      }
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Unable to start NFC scanning.');
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

  const fullReadDump = useMemo(() => {
    if (!lastRead) {
      return null;
    }

    return {
      serialNumber: lastRead.serialNumber,
      readAt: new Date(lastRead.readAt).toISOString(),
      recordCount: lastRead.records.length,
      records: lastRead.records.map((record) => ({
        recordType: record.recordType,
        mediaType: record.mediaType ?? null,
        id: record.id ?? null,
        encoding: record.encoding ?? null,
        lang: record.lang ?? null,
        payload: record.payload,
        rawHex: record.rawHex ?? null,
      })),
    };
  }, [lastRead]);

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
        <div className="fixed bottom-16 left-4 z-50 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-white/10 bg-bambu-dark-secondary p-3 shadow-2xl">
          <div className="mb-2 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Nfc className="h-4 w-4 text-bambu-green" />
              <h3 className="text-sm font-semibold text-white">NFC tag read</h3>
            </div>
            <button
              type="button"
              aria-label="Close NFC modal"
              onClick={closeModal}
              className="rounded p-1 text-bambu-gray hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-1 text-xs text-bambu-gray-light">
            <p>
              <span className="text-bambu-gray">Serial:</span> {lastRead.serialNumber}
            </p>
            <p>
              <span className="text-bambu-gray">Records:</span> {lastRead.records.length}
            </p>
            {lastRead.records.length === 0 && (
              <div className="rounded bg-amber-500/10 px-2 py-1 text-amber-200">
                No NDEF records were exposed by Web NFC.
              </div>
            )}
            {lastRead.records.slice(0, 3).map((record, index) => (
              <div key={`${record.recordType}-${record.id || index}`} className="rounded bg-bambu-dark px-2 py-1">
                <p className="text-[11px] text-bambu-gray">
                  {record.recordType}
                  {record.mediaType ? ` (${record.mediaType})` : ''}
                </p>
                <p className="truncate text-zinc-100" title={record.payload}>{record.payload}</p>
                {(record.encoding || record.lang || record.rawHex) && (
                  <p className="mt-0.5 text-[10px] text-bambu-gray">
                    {record.encoding ? `enc=${record.encoding}` : ''}
                    {record.lang ? `${record.encoding ? ' ' : ''}lang=${record.lang}` : ''}
                  </p>
                )}
                {record.rawHex && (
                  <p className="mt-1 truncate font-mono text-[10px] text-zinc-400" title={record.rawHex}>
                    {record.rawHex}
                  </p>
                )}
              </div>
            ))}
          </div>

          {fullReadDump && (
            <details className="mt-3 rounded-lg border border-white/10 bg-black/20 px-2 py-2 text-xs text-bambu-gray-light">
              <summary className="cursor-pointer list-none text-bambu-gray-light hover:text-white">
                Full Web NFC dump
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[10px] text-zinc-200">
{JSON.stringify(fullReadDump, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {errorMessage && status !== 'permission-needed' && (
        <div className="fixed bottom-16 left-4 z-40 flex max-w-sm items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}
    </>
  );
}
