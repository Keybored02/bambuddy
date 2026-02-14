import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { api, type NozzleTempHistoryResponse, type PrinterStatus } from '../api/client';
import { parseUTCDate, applyTimeFormat, type TimeFormat } from '../utils/date';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts/ThemeContext';

interface NozzleTempHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  printerId: number;
  printerName: string;
}

type TimeRange = '30m' | '6h' | '24h' | '48h' | '7d';

const TIME_RANGES: { value: TimeRange; label: string; hours: number }[] = [
  { value: '30m', label: '30m', hours: 0.5 },
  { value: '6h', label: '6h', hours: 6 },
  { value: '24h', label: '24h', hours: 24 },
  { value: '48h', label: '48h', hours: 48 },
  { value: '7d', label: '7d', hours: 168 },
];

export function NozzleTempHistoryModal({
  isOpen,
  onClose,
  printerId,
  printerName,
}: NozzleTempHistoryModalProps) {
  const { t } = useTranslation();
  const { mode: themeMode } = useTheme();
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [liveStatus, setLiveStatus] = useState<PrinterStatus | undefined>(undefined);
  const queryClient = useQueryClient();
  const isDark = themeMode === 'dark';
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  // Subscribe to live printer status updates (runs continuously in background)
  useEffect(() => {
    // Fetch initial status
    queryClient.fetchQuery({
      queryKey: ['printerStatus', printerId],
      queryFn: () => api.getPrinterStatus(printerId),
    }).then((data) => {
      setLiveStatus(data);
    }).catch(() => {
      // Ignore errors
    });

    // Subscribe to all cache updates for this printer
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const queryKey = event?.query?.queryKey;
      if (!Array.isArray(queryKey)) return;
      if (queryKey[0] !== 'printerStatus' || queryKey[1] !== printerId) return;
      const data = event?.query?.state?.data as PrinterStatus | undefined;
      if (data) {
        setLiveStatus(data);
      }
    });

    unsubscribeRef.current = unsubscribe;
    return () => unsubscribe();
  }, [printerId, queryClient]);

  const timeFormat: TimeFormat = settings?.time_format || 'system';

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch full 7-day history for longest possible range (runs continuously)
  const { data: fullHistory, refetch: refetchFull } = useQuery<NozzleTempHistoryResponse>({
    queryKey: ['nozzle-temp-history-full', printerId],
    queryFn: () => api.getNozzleTempHistory(printerId, 168), // Always fetch 7d
    staleTime: 5000,  // Refetch every 5 seconds
    refetchInterval: 5000,
    // Don't disable when modal closes - keep fetching in background
  });

  const [allSeries, setAllSeries] = useState<Array<{ time: number; left: number | null; right: number | null }>>([]);
  const lastLiveTemps = useRef<{ left: number | null; right: number | null } | null>(null);

  // Update series from fetched history
  useEffect(() => {
    if (!fullHistory?.data) return;

    const mapped = fullHistory.data.map(point => {
      const date = parseUTCDate(point.recorded_at) || new Date();
      return {
        time: date.getTime(),
        left: point.nozzle_left,
        right: point.nozzle_right,
      };
    });

    setAllSeries(mapped);
    lastLiveTemps.current = null;  // Reset live tracking
  }, [fullHistory]);

  // Append live updates to history
  useEffect(() => {
    if (!liveStatus?.temperatures) return;
    if (liveStatus.temperatures.nozzle_2 === undefined) return;

    const left = liveStatus.temperatures.nozzle ?? null;
    const right = liveStatus.temperatures.nozzle_2 ?? null;
    const last = lastLiveTemps.current;

    if (last && last.left === left && last.right === right) return;

    lastLiveTemps.current = { left, right };
    setAllSeries(prev => {
      // Check if this exact point already exists (within 1 second)
      const now = Date.now();
      const recentPoint = prev[prev.length - 1];
      if (recentPoint && now - recentPoint.time < 1000) return prev;

      return [...prev, { time: now, left, right }];
    });
  }, [liveStatus]);

  // Filter series based on selected time range
  const hours = TIME_RANGES.find(r => r.value === timeRange)?.hours || 24;
  const filteredSeries = useMemo(() => {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return allSeries.filter(point => point.time >= cutoff);
  }, [allSeries, hours]);

  const lastPoint = filteredSeries[filteredSeries.length - 1];
  const currentLeft = lastPoint?.left;
  const currentRight = lastPoint?.right;

  const stats = useMemo(() => {
    const leftValues = filteredSeries.map(p => p.left).filter((v): v is number => v != null);
    const rightValues = filteredSeries.map(p => p.right).filter((v): v is number => v != null);
    const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return {
      minLeft: leftValues.length ? Math.min(...leftValues) : null,
      maxLeft: leftValues.length ? Math.max(...leftValues) : null,
      avgLeft: avg(leftValues),
      minRight: rightValues.length ? Math.min(...rightValues) : null,
      maxRight: rightValues.length ? Math.max(...rightValues) : null,
      avgRight: avg(rightValues),
    };
  }, [filteredSeries]);

  const modalBg = isDark ? '#2d2d2d' : '#ffffff';
  const cardBg = isDark ? '#1d1d1d' : '#f3f4f6';
  const borderColor = isDark ? '#3d3d3d' : '#e5e7eb';
  const textPrimary = isDark ? '#ffffff' : '#111827';
  const textSecondary = isDark ? '#9ca3af' : '#4b5563';

  if (!isOpen) return null;

  const chartProps = {
    strokeDasharray: '3 3',
    gridStroke: isDark ? '#3d3d3d' : '#e5e7eb',
    axisStroke: isDark ? '#9ca3af' : '#6b7280',
  };

  const tooltipLabel = (ts: number) => new Date(ts).toLocaleString(undefined, applyTimeFormat({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }, timeFormat));

  const renderChart = (dataKey: 'left' | 'right', label: string, color: string) => (
    <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
      {filteredSeries.length === 0 ? (
        <div className="h-[260px] flex items-center justify-center" style={{ color: textSecondary }}>
          {t('common.noData', 'No data available for this time range')}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={filteredSeries}>
            <CartesianGrid strokeDasharray={chartProps.strokeDasharray} stroke={chartProps.gridStroke} />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(ts) => {
                const date = new Date(ts);
                if (hours > 24) {
                  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
                }
                return date.toLocaleTimeString([], applyTimeFormat({ hour: '2-digit', minute: '2-digit' }, timeFormat));
              }}
              stroke={chartProps.axisStroke}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              stroke={chartProps.axisStroke}
              tick={{ fontSize: 12 }}
              domain={['auto', 'auto']}
              tickFormatter={(value) => `${value}°C`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#2d2d2d' : '#ffffff',
                border: `1px solid ${isDark ? '#3d3d3d' : '#e5e7eb'}`,
                borderRadius: '8px',
                color: isDark ? '#fff' : '#000',
              }}
              labelFormatter={tooltipLabel}
              formatter={(value) => [`${value ?? 0}°C`, label]}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey={dataKey}
              name={label}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-xl w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-xl"
        style={{ backgroundColor: modalBg }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor }}>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: textPrimary }}>
              {t('printers.temperatures.nozzle')} {t('common.history', 'History')}
            </h2>
            <p className="text-sm" style={{ color: textSecondary }}>{printerName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors"
            style={{ color: textSecondary }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          <div className="flex items-center justify-between">
            <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: cardBg }}>
              {TIME_RANGES.map(range => (
                <button
                  key={range.value}
                  onClick={() => setTimeRange(range.value)}
                  className={`px-3 py-1 text-sm rounded-md transition-colors ${
                    timeRange === range.value ? 'bg-bambu-green text-white' : ''
                  }`}
                  style={timeRange !== range.value ? { color: textSecondary } : undefined}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold" style={{ color: textPrimary }}>
                  {t('common.left')} {t('printers.temperatures.nozzle')}
                </h3>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.current', 'Current')}</p>
                  <p className="text-2xl font-bold" style={{ color: textPrimary }}>
                    {currentLeft != null ? `${currentLeft}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.average', 'Average')}</p>
                  <p className="text-2xl font-bold" style={{ color: textPrimary }}>
                    {stats.avgLeft != null ? `${stats.avgLeft.toFixed(1)}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.min', 'Min')}</p>
                  <p className="text-2xl font-bold text-blue-500">
                    {stats.minLeft != null ? `${stats.minLeft}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.max', 'Max')}</p>
                  <p className="text-2xl font-bold text-red-500">
                    {stats.maxLeft != null ? `${stats.maxLeft}°C` : '—'}
                  </p>
                </div>
              </div>
              {renderChart('left', `${t('common.left')} ${t('printers.temperatures.nozzle')}`, '#f97316')}
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold" style={{ color: textPrimary }}>
                  {t('common.right')} {t('printers.temperatures.nozzle')}
                </h3>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.current', 'Current')}</p>
                  <p className="text-2xl font-bold" style={{ color: textPrimary }}>
                    {currentRight != null ? `${currentRight}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.average', 'Average')}</p>
                  <p className="text-2xl font-bold" style={{ color: textPrimary }}>
                    {stats.avgRight != null ? `${stats.avgRight.toFixed(1)}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.min', 'Min')}</p>
                  <p className="text-2xl font-bold text-blue-500">
                    {stats.minRight != null ? `${stats.minRight}°C` : '—'}
                  </p>
                </div>
                <div className="rounded-lg p-4" style={{ backgroundColor: cardBg }}>
                  <p className="text-xs" style={{ color: textSecondary }}>{t('common.max', 'Max')}</p>
                  <p className="text-2xl font-bold text-red-500">
                    {stats.maxRight != null ? `${stats.maxRight}°C` : '—'}
                  </p>
                </div>
              </div>
              {renderChart('right', `${t('common.right')} ${t('printers.temperatures.nozzle')}`, '#3b82f6')}
            </div>
          </div>

          <div className="text-xs text-center" style={{ color: textSecondary }}>
            {t('nozzleHistory.recordingInfo', 'Data is recorded when temperature updates are received')}
          </div>
        </div>
      </div>
    </div>
  );
}
