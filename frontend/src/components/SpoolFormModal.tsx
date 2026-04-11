import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Save, Beaker, Palette, Zap, Nfc } from 'lucide-react';
import { api } from '../api/client';
import type { InventorySpool, SlicerSetting, SpoolCatalogEntry, LocalPreset } from '../api/client';
import { normalizeHexTag, uidMatches, suppressNfcModal, unsuppressNfcModal } from '../utils/nfc';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import type { SpoolFormData, PrinterWithCalibrations, ColorPreset } from './spool-form/types';
import { defaultFormData, validateForm } from './spool-form/types';
import { buildFilamentOptions, extractBrandsFromPresets, findPresetOption, loadRecentColors, parsePresetName, saveRecentColor } from './spool-form/utils';
import { MATERIALS } from './spool-form/constants';
import { FilamentSection } from './spool-form/FilamentSection';
import { ColorSection } from './spool-form/ColorSection';
import { AdditionalSection } from './spool-form/AdditionalSection';
import { PAProfileSection } from './spool-form/PAProfileSection';
import { SpoolUsageHistory } from './SpoolUsageHistory';

type TabId = 'filament' | 'pa-profile';

type NfcScanState = 'unsupported' | 'idle' | 'scanning' | 'done' | 'error';

interface NdefReaderConstructorLike {
  new (): {
    scan: (options?: { signal?: AbortSignal }) => Promise<void>;
    onreading: ((event: { serialNumber?: string }) => void) | null;
    onreadingerror: (() => void) | null;
  };
}

// continuous=true keeps the reader alive after each read (for bulk tag collection).
// continuous=false aborts after the first read (one-shot, for single/edit modes).
function useNfcScan(isOpen: boolean, onScanned: (uid: string) => void, continuous: boolean) {
  const [scanState, setScanState] = useState<NfcScanState>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const onScannedRef = useRef(onScanned);
  const continuousRef = useRef(continuous);
  useEffect(() => { onScannedRef.current = onScanned; }, [onScanned]);
  useEffect(() => { continuousRef.current = continuous; }, [continuous]);

  const isSupported = typeof window !== 'undefined' &&
    !!(window as unknown as { NDEFReader?: unknown }).NDEFReader;

  const startScan = useCallback(async () => {
    const ReaderCtor = (window as unknown as { NDEFReader?: NdefReaderConstructorLike }).NDEFReader;
    if (!ReaderCtor) { setScanState('unsupported'); return; }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setScanState('scanning');
    suppressNfcModal();
    try {
      const reader = new ReaderCtor();
      reader.onreading = (event) => {
        const uid = normalizeHexTag(event.serialNumber) || (event.serialNumber ?? '');
        onScannedRef.current(uid);
        if (!continuousRef.current) {
          // One-shot: stop after first read. Suppression lifted by stopScan/close.
          setScanState('done');
          ac.abort();
        }
        // Continuous: stay scanning, reader keeps firing for subsequent tags.
      };
      reader.onreadingerror = () => {
        setScanState('error');
        ac.abort();
      };
      await reader.scan({ signal: ac.signal });
    } catch (e) {
      // AbortError is expected — not a real error.
      if ((e as Error)?.name !== 'AbortError') {
        setScanState('error');
        unsuppressNfcModal();
      }
    }
  }, []);

  const stopScan = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    unsuppressNfcModal();
    setScanState(isSupported ? 'idle' : 'unsupported');
  }, [isSupported]);

  useEffect(() => {
    if (!isOpen) stopScan();
  }, [isOpen, stopScan]);

  return { scanState, startScan, stopScan, isSupported };
}

interface SpoolFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  spool?: InventorySpool | null;
  printersWithCalibrations?: PrinterWithCalibrations[];
  currencySymbol: string;
  onSpoolsCreated?: (spools: InventorySpool[]) => void;
}

export function SpoolFormModal({
  isOpen,
  onClose,
  spool,
  printersWithCalibrations = [],
  currencySymbol,
  onSpoolsCreated,
}: SpoolFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const isEditing = !!spool;

  // Form state
  const [formData, setFormData] = useState<SpoolFormData>(defaultFormData);
  const [errors, setErrors] = useState<Partial<Record<keyof SpoolFormData, string>>>({});
  const [activeTab, setActiveTab] = useState<TabId>('filament');
  const [weightTouched, setWeightTouched] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [quantity, setQuantity] = useState(1);

  // NFC tag state
  // Single mode (create qty=1 / edit): one UID or null
  const [pendingTagUid, setPendingTagUid] = useState<string | null>(null);
  // Bulk mode (create qty>1 with NFC active): ordered list, one per spool
  const [pendingBulkUids, setPendingBulkUids] = useState<string[]>([]);

  // Continuous scan only in bulk create mode (qty>1, quickAdd, not editing)
  const isBulkNfcMode = !isEditing && quickAdd && quantity > 1;

  // Inventory spools for UID conflict checks
  const { data: allSpools = [] } = useQuery({
    queryKey: ['inventory-spools'],
    queryFn: () => api.getSpools(false),
    staleTime: 30 * 1000,
    enabled: isOpen,
  });

  // Validate a scanned UID and route it to the right state bucket.
  // Returns true if accepted, false if rejected (so caller can decide to keep scanning).
  const handleNfcScanned = useCallback((uid: string) => {
    if (!uid) return;

    if (isBulkNfcMode) {
      setPendingBulkUids(prev => {
        // Already collected enough tags
        if (prev.length >= quantity) return prev;

        // Duplicate within this session
        if (prev.includes(uid)) {
          showToast('Tag already scanned in this session — scan a different tag', 'warning');
          return prev;
        }

        // Resolves to an existing inventory spool
        const existing = allSpools.find(s => uidMatches(uid, s.tag_uid));
        if (existing) {
          const label = [existing.brand, existing.material, existing.color_name].filter(Boolean).join(' ');
          showToast(`Tag already linked to "${label}" — scan a different tag`, 'error');
          return prev;
        }

        return [...prev, uid];
      });
    } else {
      // Single create or edit
      const existing = allSpools.find(s => uidMatches(uid, s.tag_uid));
      if (existing) {
        if (isEditing && existing.id === spool?.id) {
          // Re-scanning the tag already on this spool — warn but allow
          showToast('This tag is already linked to this spool', 'warning');
          setPendingTagUid(uid);
        } else {
          const label = [existing.brand, existing.material, existing.color_name].filter(Boolean).join(' ');
          showToast(`Tag already linked to "${label}"`, 'error');
        }
        return;
      }
      setPendingTagUid(uid);
    }
  // allSpools, quantity, isBulkNfcMode, isEditing, spool?.id intentionally excluded from
  // deps — we capture via refs inside the hook and these are stable enough per render.
  // showToast is stable from context.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulkNfcMode, quantity, isEditing, spool?.id, showToast, allSpools]);

  const { scanState, startScan, stopScan, isSupported: nfcSupported } = useNfcScan(
    isOpen,
    handleNfcScanned,
    isBulkNfcMode,
  );

  // When bulk mode is exited (quantity drops to 1, or quickAdd toggled off),
  // stop any active scan and clear collected tags.
  useEffect(() => {
    if (!isBulkNfcMode) {
      stopScan();
      setPendingBulkUids([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulkNfcMode]);

  // Stop continuous scan once all tags are collected
  useEffect(() => {
    if (isBulkNfcMode && pendingBulkUids.length >= quantity && quantity > 0) {
      stopScan();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBulkUids.length, quantity, isBulkNfcMode]);

  // Cloud presets
  const [cloudAuthenticated, setCloudAuthenticated] = useState(false);
  const [loadingCloudPresets, setLoadingCloudPresets] = useState(false);
  const [cloudPresets, setCloudPresets] = useState<SlicerSetting[]>([]);
  const [presetInputValue, setPresetInputValue] = useState('');

  // Spool catalog
  const [spoolCatalog, setSpoolCatalog] = useState<SpoolCatalogEntry[]>([]);

  // Local presets (OrcaSlicer imports)
  const [localPresets, setLocalPresets] = useState<LocalPreset[]>([]);

  // Color catalog
  const [colorCatalog, setColorCatalog] = useState<{ manufacturer: string; color_name: string; hex_color: string; material: string | null }[]>([]);

  // Color state
  const [recentColors, setRecentColors] = useState<ColorPreset[]>([]);

  // PA Profile state
  const [fetchedCalibrations, setFetchedCalibrations] = useState<PrinterWithCalibrations[]>([]);
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(new Set());
  const [expandedPrinters, setExpandedPrinters] = useState<Set<string>>(new Set());

  // Use prop if provided, otherwise use self-fetched data
  const resolvedCalibrations = printersWithCalibrations.length > 0
    ? printersWithCalibrations
    : fetchedCalibrations;

  // Count selected PA profiles for tab badge
  const selectedProfileCount = useMemo(() => {
    return selectedProfiles.size;
  }, [selectedProfiles]);

  // Load recent colors on mount
  useEffect(() => {
    setRecentColors(loadRecentColors());
  }, []);

  // Fetch cloud presets and catalog when modal opens
  useEffect(() => {
    if (isOpen) {
      const fetchData = async () => {
        setLoadingCloudPresets(true);
        try {
          const status = await api.getCloudStatus();
          setCloudAuthenticated(status.is_authenticated);
          if (status.is_authenticated) {
            const presets = await api.getFilamentPresets();
            setCloudPresets(presets);
          }
        } catch (e) {
          console.error('Failed to fetch cloud presets:', e);
          setCloudAuthenticated(false);
        } finally {
          setLoadingCloudPresets(false);
        }
      };
      fetchData();
      api.getSpoolCatalog().then(setSpoolCatalog).catch(console.error);
      api.getColorCatalog().then(setColorCatalog).catch(console.error);
      api.getLocalPresets().then(r => setLocalPresets(r.filament)).catch(console.error);

      // Fetch printer calibrations if not provided via props
      if (printersWithCalibrations.length === 0) {
        (async () => {
          try {
            const printers = await api.getPrinters();
            const statuses = await Promise.all(
              printers.map(p => api.getPrinterStatus(p.id).catch(() => null)),
            );
            const results: PrinterWithCalibrations[] = [];
            for (let i = 0; i < printers.length; i++) {
              const printer = printers[i];
              const status = statuses[i];
              const connected = status?.connected ?? false;
              let calibrations: PrinterWithCalibrations['calibrations'] = [];
              if (connected) {
                try {
                  const kRes = await api.getKProfiles(printer.id);
                  calibrations = kRes.profiles.map(p => ({
                    cali_idx: p.slot_id,
                    filament_id: p.filament_id,
                    setting_id: p.setting_id || '',
                    name: p.name,
                    k_value: parseFloat(p.k_value) || 0,
                    n_coef: parseFloat(p.n_coef) || 0,
                    extruder_id: p.extruder_id,
                    nozzle_diameter: p.nozzle_diameter,
                  }));
                } catch {
                  // Printer may not support K-profiles
                }
              }
              results.push({ printer: { ...printer, connected }, calibrations });
            }
            setFetchedCalibrations(results);
          } catch (e) {
            console.error('Failed to fetch printer calibrations:', e);
          }
        })();
      }
    }
  }, [isOpen, printersWithCalibrations.length]);

  // Build filament options: cloud → local → fallback
  const filamentOptions = useMemo(
    () => buildFilamentOptions(cloudPresets, new Set(), localPresets),
    [cloudPresets, localPresets],
  );

  // Extract brands from presets
  const baseAvailableBrands = useMemo(() => {
    const presetBrands = extractBrandsFromPresets(cloudPresets, localPresets);
    const catalogBrands = colorCatalog
      .map(entry => entry.manufacturer?.trim())
      .filter((brand): brand is string => !!brand);
    const brandSet = new Set<string>([...presetBrands, ...catalogBrands]);
    return Array.from(brandSet).sort((a, b) => a.localeCompare(b));
  }, [cloudPresets, localPresets, colorCatalog]);

  const baseAvailableMaterials = useMemo(() => {
    const catalogMaterials = colorCatalog
      .map(entry => entry.material?.trim())
      .filter((material): material is string => !!material);
    const materialSet = new Set<string>([...MATERIALS, ...catalogMaterials]);
    return Array.from(materialSet).sort((a, b) => a.localeCompare(b));
  }, [colorCatalog]);

  const brandMaterialPairs = useMemo(() => {
    const pairs: Array<{ brand: string; material: string }> = [];

    for (const entry of colorCatalog) {
      const brand = entry.manufacturer?.trim();
      const material = entry.material?.trim();
      if (brand && material) pairs.push({ brand, material });
    }

    for (const preset of cloudPresets) {
      const parsed = parsePresetName(preset.name);
      if (parsed.brand && parsed.material) {
        pairs.push({ brand: parsed.brand, material: parsed.material });
      }
    }

    for (const preset of localPresets) {
      const parsed = parsePresetName(preset.name);
      const brand = preset.filament_vendor?.trim() || parsed.brand;
      const material = parsed.material;
      if (brand && material) {
        pairs.push({ brand, material });
      }
    }

    return pairs;
  }, [cloudPresets, colorCatalog, localPresets]);

  const brandToMaterials = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const pair of brandMaterialPairs) {
      const brandKey = pair.brand.toLowerCase();
      const materialKey = pair.material.toLowerCase();
      if (!map.has(brandKey)) map.set(brandKey, new Set());
      map.get(brandKey)!.add(materialKey);
    }
    return map;
  }, [brandMaterialPairs]);

  const materialToBrands = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const pair of brandMaterialPairs) {
      const brandKey = pair.brand.toLowerCase();
      const materialKey = pair.material.toLowerCase();
      if (!map.has(materialKey)) map.set(materialKey, new Set());
      map.get(materialKey)!.add(brandKey);
    }
    return map;
  }, [brandMaterialPairs]);

  const availableBrands = useMemo(() => {
    if (!formData.material) return baseAvailableBrands;
    const materialKey = formData.material.toLowerCase();
    const brandKeys = materialToBrands.get(materialKey);
    if (!brandKeys || brandKeys.size === 0) return baseAvailableBrands;
    return baseAvailableBrands.filter(brand => brandKeys.has(brand.toLowerCase()));
  }, [baseAvailableBrands, formData.material, materialToBrands]);

  const availableMaterials = useMemo(() => {
    if (!formData.brand) return baseAvailableMaterials;
    const brandKey = formData.brand.toLowerCase();
    const materialKeys = brandToMaterials.get(brandKey);
    if (!materialKeys || materialKeys.size === 0) return baseAvailableMaterials;
    return baseAvailableMaterials.filter(material => materialKeys.has(material.toLowerCase()));
  }, [baseAvailableMaterials, formData.brand, brandToMaterials]);

  // Find selected preset option
  const selectedPresetOption = useMemo(
    () => findPresetOption(formData.slicer_filament, filamentOptions),
    [formData.slicer_filament, filamentOptions],
  );

  // Reset form when modal opens/closes or spool changes
  useEffect(() => {
    if (isOpen) {
      if (spool) {
        setFormData({
          material: spool.material || '',
          subtype: spool.subtype || '',
          brand: spool.brand || '',
          color_name: spool.color_name || '',
          rgba: spool.rgba || '808080FF',
          label_weight: spool.label_weight || 1000,
          core_weight: spool.core_weight || 250,
          core_weight_catalog_id: spool.core_weight_catalog_id ?? null,
          weight_used: spool.weight_used || 0,
          slicer_filament: spool.slicer_filament || '',
          note: spool.note || '',
          cost_per_kg: spool.cost_per_kg ?? null,
        });
        setPresetInputValue(spool.slicer_filament_name || spool.slicer_filament || '');
        setPendingTagUid(spool.tag_uid ?? null);

        // Load K-profiles for this spool
        if (spool.k_profiles && spool.k_profiles.length > 0) {
          const profileKeys = new Set<string>();
          for (const p of spool.k_profiles) {
            if (p.cali_idx !== null && p.cali_idx !== undefined) {
              profileKeys.add(`${p.printer_id}:${p.cali_idx}:${p.extruder ?? 'null'}`);
            }
          }
          setSelectedProfiles(profileKeys);
        } else {
          setSelectedProfiles(new Set());
        }
      } else {
        setFormData(defaultFormData);
        setPresetInputValue('');
        setSelectedProfiles(new Set());
        setPendingTagUid(null);
        setPendingBulkUids([]);
        setQuickAdd(false);
        setQuantity(1);
      }
      setErrors({});
      setActiveTab('filament');
      setWeightTouched(false);
    }
  }, [isOpen, spool]);

  // Expand all printers in PA profile section when calibrations are available
  useEffect(() => {
    if (isOpen && resolvedCalibrations.length > 0) {
      setExpandedPrinters(new Set(resolvedCalibrations.map(p => String(p.printer.id))));
    }
  }, [isOpen, resolvedCalibrations]);

  // Update field helper
  const updateField = <K extends keyof SpoolFormData>(key: K, value: SpoolFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    if (key === 'weight_used') setWeightTouched(true);
    if (errors[key]) {
      setErrors(prev => ({ ...prev, [key]: undefined }));
    }
  };

  // Handle color selection
  const handleColorUsed = (color: ColorPreset) => {
    setRecentColors(prev => saveRecentColor(color, prev));
  };

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.createSpool(data as Parameters<typeof api.createSpool>[0]),
    onSuccess: async (newSpool) => {
      // Save K-profiles if any selected
      if (selectedProfiles.size > 0 && newSpool?.id) {
        await saveKProfiles(newSpool.id);
      }
      await queryClient.invalidateQueries({ queryKey: ['inventory-spools'] });
      if (onSpoolsCreated) onSpoolsCreated([newSpool]);
      showToast(t('inventory.spoolCreated'), 'success');
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const bulkCreateMutation = useMutation({
    mutationFn: ({ data, qty }: { data: Record<string, unknown>; qty: number }) =>
      api.bulkCreateSpools(data as Parameters<typeof api.bulkCreateSpools>[0], qty),
    onSuccess: async (newSpools) => {
      if (selectedProfiles.size > 0) {
        for (const spool of newSpools) {
          await saveKProfiles(spool.id);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['inventory-spools'] });
      if (onSpoolsCreated) onSpoolsCreated(newSpools);
      showToast(t('inventory.spoolsCreated', { count: newSpools.length }), 'success');
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  // Bulk create with mixed NFC UIDs: create tagged spools one-by-one,
  // then bulk-create any remainder without tags.
  const bulkNfcCreateMutation = useMutation({
    mutationFn: async ({ taggedData, remainder, baseData }: {
      taggedData: Record<string, unknown>[];
      remainder: number;
      baseData: Record<string, unknown>;
    }) => {
      const created: InventorySpool[] = [];
      for (const d of taggedData) {
        const s = await api.createSpool(d as Parameters<typeof api.createSpool>[0]);
        created.push(s);
      }
      if (remainder > 0) {
        const bulk = await api.bulkCreateSpools(
          baseData as Parameters<typeof api.bulkCreateSpools>[0],
          remainder,
        );
        created.push(...bulk);
      }
      return created;
    },
    onSuccess: async (newSpools) => {
      if (selectedProfiles.size > 0) {
        for (const s of newSpools) await saveKProfiles(s.id);
      }
      await queryClient.invalidateQueries({ queryKey: ['inventory-spools'] });
      if (onSpoolsCreated) onSpoolsCreated(newSpools);
      showToast(t('inventory.spoolsCreated', { count: newSpools.length }), 'success');
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.updateSpool(spool!.id, data as Parameters<typeof api.updateSpool>[1]),
    onSuccess: async () => {
      // Save K-profiles
      if (spool?.id) {
        await saveKProfiles(spool.id);
      }
      await queryClient.invalidateQueries({ queryKey: ['inventory-spools'] });
      showToast(t('inventory.spoolUpdated'), 'success');
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message, 'error');
    },
  });


  // Save K-profiles for selected calibrations
  const saveKProfiles = async (spoolId: number) => {
    if (selectedProfiles.size === 0) {
      // Clear existing K-profiles
      try {
        await api.saveSpoolKProfiles(spoolId, []);
      } catch {
        // Ignore
      }
      return;
    }

    const profiles = [];
    for (const key of selectedProfiles) {
      const [printerIdStr, caliIdxStr, extruderStr] = key.split(':');
      const printerId = parseInt(printerIdStr);
      const caliIdx = parseInt(caliIdxStr);
      const extruder = extruderStr === 'null' ? 0 : parseInt(extruderStr);

      // Find the matching calibration
      const pc = resolvedCalibrations.find(p => p.printer.id === printerId);
      if (pc) {
        const cal = pc.calibrations.find(c => c.cali_idx === caliIdx);
        if (cal) {
          profiles.push({
            printer_id: printerId,
            extruder,
            nozzle_diameter: cal.nozzle_diameter || '0.4',
            k_value: cal.k_value,
            name: cal.name || null,
            cali_idx: cal.cali_idx,
            setting_id: cal.setting_id || null,
          });
        }
      }
    }

    if (profiles.length > 0) {
      try {
        await api.saveSpoolKProfiles(spoolId, profiles);
      } catch (e) {
        console.error('Failed to save K-profiles:', e);
      }
    }
  };

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (isBulkIncomplete) {
      showToast(`Scan all ${quantity} tags before saving (${pendingBulkUids.length}/${quantity} done)`, 'error');
      return;
    }

    const validation = validateForm(formData, quickAdd);
    if (!validation.isValid) {
      setErrors(validation.errors);
      // Switch to filament tab if there are errors there
      if (validation.errors.slicer_filament || validation.errors.material || validation.errors.brand || validation.errors.subtype) {
        setActiveTab('filament');
      }
      return;
    }

    // Find preset name from selected option
    const presetName = selectedPresetOption?.displayName || presetInputValue || null;

    const data: Record<string, unknown> = {
      material: formData.material,
      subtype: formData.subtype || null,
      brand: formData.brand || null,
      color_name: formData.color_name || null,
      rgba: formData.rgba || null,
      label_weight: formData.label_weight,
      core_weight: formData.core_weight,
      core_weight_catalog_id: formData.core_weight_catalog_id,
      slicer_filament: formData.slicer_filament || null,
      slicer_filament_name: presetName,
      nozzle_temp_min: null,
      nozzle_temp_max: null,
      note: formData.note || null,
      cost_per_kg: formData.cost_per_kg,
    };

    // Only send weight_used when creating or when explicitly changed by the user.
    // This prevents stale cached values from overwriting usage-tracker data.
    if (!isEditing || weightTouched) {
      data.weight_used = formData.weight_used;
    }

    if (isEditing) {
      // Always send tag fields so clearing (null) is honoured
      data.tag_uid = pendingTagUid;
      if (pendingTagUid && pendingTagUid !== spool?.tag_uid) {
        data.tag_type = 'generic';
        data.data_origin = 'nfc_scan';
      } else if (!pendingTagUid) {
        data.tag_type = null;
        data.data_origin = null;
      }
      updateMutation.mutate(data);
    } else if (quantity > 1 && pendingBulkUids.length > 0) {
      // Bulk create with NFC tags: create one spool per scanned UID,
      // then fill the remainder (if any) without a tag via bulkCreate.
      const taggedData = pendingBulkUids.map(uid => ({
        ...data,
        tag_uid: uid,
        tag_type: 'generic',
        data_origin: 'nfc_scan',
        weight_used: formData.weight_used,
      }));
      const remainder = quantity - pendingBulkUids.length;
      bulkNfcCreateMutation.mutate({ taggedData, remainder, baseData: data });
    } else if (quantity > 1) {
      bulkCreateMutation.mutate({ data, qty: quantity });
    } else {
      // Single create
      if (pendingTagUid) {
        data.tag_uid = pendingTagUid;
        data.tag_type = 'generic';
        data.data_origin = 'nfc_scan';
      }
      createMutation.mutate(data);
    }
  };

  const isPending = createMutation.isPending || bulkCreateMutation.isPending || bulkNfcCreateMutation.isPending || updateMutation.isPending;
  const isBulkIncomplete = isBulkNfcMode && pendingBulkUids.length < quantity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-xl mx-4 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">
            {isEditing ? t('inventory.editSpool') : t('inventory.addSpool')}
          </h2>
          <div className="flex items-center gap-1">
            {/* NFC widget — both create and edit modes */}
            <div className="flex items-center gap-1.5 mr-1">
              {isBulkNfcMode ? (
                /* Bulk mode: x/total counter + scan/stop control */
                <div className="flex items-center gap-1.5">
                  <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 border text-xs font-medium ${
                    pendingBulkUids.length >= quantity
                      ? 'bg-bambu-green/10 border-bambu-green/30 text-bambu-green'
                      : 'bg-bambu-dark-tertiary border-bambu-dark-tertiary text-bambu-gray-light'
                  }`}>
                    <Nfc className={`w-3.5 h-3.5 ${pendingBulkUids.length >= quantity ? 'text-bambu-green' : scanState === 'scanning' ? 'text-bambu-green animate-nfc-breathe' : 'text-bambu-gray'}`} />
                    <span className="font-mono">{pendingBulkUids.length}/{quantity}</span>
                    {pendingBulkUids.length > 0 && pendingBulkUids.length < quantity && (
                      <button
                        type="button"
                        onClick={() => setPendingBulkUids([])}
                        className="text-bambu-gray/60 hover:text-bambu-gray transition-colors ml-0.5"
                        title="Clear all scanned tags"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {pendingBulkUids.length < quantity && (
                    scanState === 'scanning' ? (
                      <button
                        type="button"
                        onClick={stopScan}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg border border-bambu-green/50 bg-bambu-green/10 text-bambu-green text-xs font-medium"
                        title="Stop scanning"
                      >
                        <X className="w-3 h-3" />
                        Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={startScan}
                        disabled={!nfcSupported}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-medium transition-colors ${
                          !nfcSupported
                            ? 'border-bambu-dark-tertiary text-bambu-gray/40 cursor-not-allowed'
                            : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green/50 hover:text-bambu-green'
                        }`}
                        title={!nfcSupported ? 'Web NFC not supported' : 'Start scanning tags'}
                      >
                        <Nfc className="w-3.5 h-3.5" />
                        Scan
                      </button>
                    )
                  )}
                </div>
              ) : pendingTagUid ? (
                /* Tag assigned: green pill + X to unassign (local only, committed on save) */
                <div className="flex items-center gap-1.5 bg-bambu-green/10 border border-bambu-green/30 rounded-lg px-2.5 py-1">
                  <Nfc className="w-4 h-4 text-bambu-green shrink-0" />
                  <span className="font-mono text-[11px] text-bambu-green max-w-[100px] truncate" title={pendingTagUid}>
                    {pendingTagUid.slice(-8)}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setPendingTagUid(null); stopScan(); }}
                    className="text-bambu-green/60 hover:text-bambu-green transition-colors ml-0.5"
                    title="Unassign tag (saved on submit)"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                /* No tag: scan button */
                <button
                  type="button"
                  onClick={startScan}
                  disabled={!nfcSupported || scanState === 'scanning'}
                  title={
                    !nfcSupported ? 'Web NFC not supported on this device'
                      : scanState === 'scanning' ? 'Scanning for NFC tag...'
                      : 'Scan NFC tag to assign to spool'
                  }
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors ${
                    !nfcSupported
                      ? 'border-bambu-dark-tertiary text-bambu-gray/40 cursor-not-allowed'
                      : scanState === 'scanning'
                        ? 'border-bambu-green/50 text-bambu-green bg-bambu-green/10 cursor-default'
                        : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green/50 hover:text-bambu-green'
                  }`}
                >
                  <Nfc className={`w-4 h-4 ${
                    !nfcSupported ? 'text-bambu-gray/40'
                      : scanState === 'scanning' ? 'text-bambu-green animate-nfc-breathe'
                      : 'text-bambu-gray'
                  }`} />
                  {scanState === 'scanning' ? 'Scanning...' : 'Scan Tag'}
                </button>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1 text-bambu-gray hover:text-white rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Quick Add toggle — only in create mode */}
        {!isEditing && (
          <div className="flex items-center justify-between px-4 py-2 border-b border-bambu-dark-tertiary flex-shrink-0">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-sm text-white">{t('inventory.quickAdd')}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setQuickAdd(!quickAdd);
                if (!quickAdd) setActiveTab('filament');
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                quickAdd ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  quickAdd ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-bambu-dark-tertiary flex-shrink-0">
          <button
            onClick={() => setActiveTab('filament')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              activeTab === 'filament'
                ? 'text-bambu-green border-b-2 border-bambu-green'
                : 'text-bambu-gray hover:text-white'
            }`}
          >
            <Palette className="w-4 h-4" />
            {t('inventory.filamentInfoTab')}
          </button>
          {!quickAdd && (
            <button
              onClick={() => setActiveTab('pa-profile')}
              className={`flex-1 px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                activeTab === 'pa-profile'
                  ? 'text-bambu-green border-b-2 border-bambu-green'
                  : 'text-bambu-gray hover:text-white'
              }`}
            >
              <Beaker className="w-4 h-4" />
              {t('inventory.paProfileTab')}
              {selectedProfileCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-bambu-green/20 text-bambu-green">
                  {selectedProfileCount}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1" style={{ scrollbarGutter: 'stable' }}>
          {activeTab === 'filament' ? (
            <div className="space-y-6">
              {/* Filament Info Section */}
              <div>
                <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
                  {t('inventory.filamentInfo')}
                </h3>
                <FilamentSection
                  formData={formData}
                  updateField={updateField}
                  cloudAuthenticated={cloudAuthenticated}
                  loadingCloudPresets={loadingCloudPresets}
                  presetInputValue={presetInputValue}
                  setPresetInputValue={setPresetInputValue}
                  selectedPresetOption={selectedPresetOption}
                  filamentOptions={filamentOptions}
                  availableBrands={availableBrands}
                  availableMaterials={availableMaterials}
                  quickAdd={quickAdd}
                  quantity={quantity}
                  onQuantityChange={setQuantity}
                  errors={errors}
                />
              </div>

              {/* Color Section */}
              <div>
                <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
                  {t('inventory.color')}
                </h3>
                <ColorSection
                  formData={formData}
                  updateField={updateField}
                  recentColors={recentColors}
                  onColorUsed={handleColorUsed}
                  catalogColors={colorCatalog}
                />
              </div>

              {/* Additional Section */}
              <div>
                <h3 className="text-sm font-semibold text-bambu-gray uppercase tracking-wide mb-3">
                  {t('inventory.additional')}
                </h3>
                <AdditionalSection
                  formData={formData}
                  updateField={updateField}
                  spoolCatalog={spoolCatalog}
                  currencySymbol={currencySymbol}
                />
              </div>

              {/* Usage History (only when editing) */}
              {isEditing && spool && (
                <div>
                  <SpoolUsageHistory spoolId={spool.id} />
                </div>
              )}
            </div>
          ) : (
            <PAProfileSection
              formData={formData}
              updateField={updateField}
              printersWithCalibrations={resolvedCalibrations}
              selectedProfiles={selectedProfiles}
              setSelectedProfiles={setSelectedProfiles}
              expandedPrinters={expandedPrinters}
              setExpandedPrinters={setExpandedPrinters}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-bambu-dark-tertiary flex-shrink-0">
          <div className="flex gap-2 ml-auto">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || isBulkIncomplete}
            title={isBulkIncomplete ? `Scan all ${quantity} tags first (${pendingBulkUids.length}/${quantity} done)` : undefined}
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.saving')}
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                {isEditing ? t('common.save') : t('inventory.addSpool')}
              </>
            )}
          </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
