import { useEffect, useRef, useState } from 'react';
import { ru } from '../../i18n/ru.ts';
import { Icon } from '../icons.tsx';
import { normalizeHex } from './palette.ts';
import {
  PASTEL_PRESETS,
  hexToHsv,
  hsvToHex,
  hsvToPad,
  hsvToRgb,
  isPastelHsv,
  padToHsv,
  toPastelHsv,
  type Hsv,
} from './colorMath.ts';

export type ColorPickerMode = 'normal' | 'pastel';

const PAD_WIDTH = 240;
const PAD_HEIGHT = 148;

const NORMAL_HUE_GRADIENT =
  'linear-gradient(90deg, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)';

const PASTEL_HUE_GRADIENT = `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360]
  .map((deg, idx) => `${hsvToHex(deg, 0.3, 0.88)} ${Math.round((idx / 6) * 100)}%`)
  .join(', ')})`;

export function ColorPickerPopover({
  activeHex,
  mode,
  onModeChange,
  onPickNew,
  onEditCurrent,
  onClose,
}: {
  activeHex: string;
  mode: ColorPickerMode;
  onModeChange: (mode: ColorPickerMode) => void;
  onPickNew: (hex: string) => void;
  onEditCurrent: (hex: string) => void;
  onClose: () => void;
}) {
  const initialNormalized = normalizeHex(activeHex) ?? '#000000';
  const [hsv, setHsv] = useState<Hsv>(() => {
    const base = hexToHsv(initialNormalized);
    return mode === 'pastel' && !isPastelHsv(base) ? toPastelHsv(base) : base;
  });
  const [hexText, setHexText] = useState(() => hsvToHex(hsv.h, hsv.s, hsv.v));
  const padRef = useRef<HTMLCanvasElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const padDragging = useRef(false);
  const hueDragging = useRef(false);

  // Keep picker synced when the user clicks a different swatch while the picker is open.
  useEffect(() => {
    const normalized = normalizeHex(activeHex) ?? '#000000';
    const next = hexToHsv(normalized);
    setHsv(next);
    setHexText(normalized);
    if (mode === 'pastel' && !isPastelHsv(next)) {
      onModeChange('normal');
    }
    // Intentionally only re-sync when activeHex changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHex]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pastel = mode === 'pastel';
  const draftHex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const unchanged = draftHex === initialNormalized;

  // Render the 2D HSV field on canvas whenever hue or mode changes.
  useEffect(() => {
    const canvas = padRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(PAD_WIDTH, PAD_HEIGHT);
    const data = image.data;
    for (let y = 0; y < PAD_HEIGHT; y += 1) {
      const ny = y / (PAD_HEIGHT - 1);
      for (let x = 0; x < PAD_WIDTH; x += 1) {
        const nx = x / (PAD_WIDTH - 1);
        const point = padToHsv(nx, ny, hsv.h, pastel);
        const { r, g, b } = hsvToRgb(point.h, point.s, point.v);
        const offset = (y * PAD_WIDTH + x) * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [hsv.h, pastel]);

  const applyHsv = (next: Hsv) => {
    setHsv(next);
    setHexText(hsvToHex(next.h, next.s, next.v));
  };

  const switchMode = (nextMode: ColorPickerMode) => {
    if (nextMode === mode) return;
    onModeChange(nextMode);
    if (nextMode === 'pastel') {
      applyHsv(toPastelHsv(hsv));
    }
  };

  const updateFromPad = (clientX: number, clientY: number) => {
    const canvas = padRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    applyHsv(padToHsv(nx, ny, hsv.h, pastel));
  };

  const updateFromHue = (clientX: number) => {
    const bar = hueRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const nextH = ratio * 359.9;
    applyHsv({ ...hsv, h: nextH });
  };

  const cursor = hsvToPad(hsv, pastel);
  const huePercent = (hsv.h / 360) * 100;
  const hueThumbHex = pastel ? hsvToHex(hsv.h, 0.3, 0.88) : hsvToHex(hsv.h, 1, 1);

  return (
    <div
      className="color-picker-pop"
      role="dialog"
      aria-label={ru.editColor}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="cp-head">
        <div className="cp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!pastel}
            className="cp-tab"
            onClick={() => switchMode('normal')}
          >
            {ru.colorNormal}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pastel}
            className="cp-tab"
            onClick={() => switchMode('pastel')}
          >
            {ru.colorPastel}
          </button>
        </div>
        <button
          type="button"
          className="cp-close"
          aria-label={ru.close}
          title={ru.close}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>

      <div
        className="cp-pad-wrap"
        role="slider"
        aria-label={ru.colorField}
        aria-valuetext={draftHex}
        tabIndex={0}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          padDragging.current = true;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Ignore capture failure on synthetic pointers.
          }
          updateFromPad(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!padDragging.current) return;
          updateFromPad(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (!padDragging.current) return;
          padDragging.current = false;
          try {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } catch {
            // Ignore release failure.
          }
        }}
        onPointerCancel={() => {
          padDragging.current = false;
        }}
      >
        <canvas ref={padRef} width={PAD_WIDTH} height={PAD_HEIGHT} className="cp-pad" />
        <span
          className="cp-reticle"
          style={{
            left: `${cursor.nx * 100}%`,
            top: `${cursor.ny * 100}%`,
            background: draftHex,
          }}
        />
      </div>

      <div
        ref={hueRef}
        className="cp-hue"
        role="slider"
        aria-label={ru.colorHue}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        style={{ background: pastel ? PASTEL_HUE_GRADIENT : NORMAL_HUE_GRADIENT }}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          hueDragging.current = true;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Ignore capture failure.
          }
          updateFromHue(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!hueDragging.current) return;
          updateFromHue(event.clientX);
        }}
        onPointerUp={(event) => {
          if (!hueDragging.current) return;
          hueDragging.current = false;
          try {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } catch {
            // Ignore release failure.
          }
        }}
        onPointerCancel={() => {
          hueDragging.current = false;
        }}
      >
        <span
          className="cp-hue-thumb"
          style={{ left: `${huePercent}%`, background: hueThumbHex }}
        />
      </div>

      {pastel ? (
        <div className="cp-presets" aria-label={ru.pastelPresets}>
          {PASTEL_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="cp-preset"
              style={{ background: preset }}
              aria-label={preset}
              title={preset}
              aria-pressed={draftHex === preset}
              onClick={() => {
                applyHsv(hexToHsv(preset));
              }}
            />
          ))}
        </div>
      ) : null}

      <div className="cp-meta">
        <div className="cp-compare">
          <button
            type="button"
            className="cp-before"
            style={{ background: initialNormalized }}
            title={ru.resetColor}
            aria-label={ru.resetColor}
            onClick={() => {
              const reset = hexToHsv(initialNormalized);
              if (pastel && !isPastelHsv(reset)) onModeChange('normal');
              applyHsv(reset);
            }}
          />
          <span className="cp-after" style={{ background: draftHex }} />
        </div>
        <input
          type="text"
          className="cp-hex"
          aria-label="HEX"
          value={hexText}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const raw = event.target.value;
            setHexText(raw);
            const candidate = raw.startsWith('#') ? raw : `#${raw}`;
            const normalized = normalizeHex(candidate);
            if (normalized) {
              const next = hexToHsv(normalized);
              setHsv(next);
              if (pastel && !isPastelHsv(next)) onModeChange('normal');
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onPickNew(draftHex);
              onClose();
            }
          }}
        />
      </div>

      <div className="cp-actions">
        <button
          type="button"
          className="cp-btn primary"
          onClick={() => {
            onPickNew(draftHex);
            onClose();
          }}
        >
          {ru.applyColor}
        </button>
        <button
          type="button"
          className="cp-btn"
          disabled={unchanged}
          title={ru.editColor}
          onClick={() => {
            onEditCurrent(draftHex);
            onClose();
          }}
        >
          {ru.replaceColor}
        </button>
      </div>
    </div>
  );
}
