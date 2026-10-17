import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'pencil'
  | 'eraser'
  | 'fill'
  | 'picker'
  | 'line'
  | 'circle'
  | 'rect'
  | 'diamond'
  | 'select'
  | 'pan'
  | 'undo'
  | 'redo'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'chevronDown'
  | 'panel'
  | 'fit'
  | 'zoom'
  | 'grid'
  | 'checker'
  | 'axisV'
  | 'axisH'
  | 'eye'
  | 'lock'
  | 'unlock'
  | 'snapEdge'
  | 'snapCenter'
  | 'crosshair'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'image'
  | 'file'
  | 'cloud'
  | 'check'
  | 'alert'
  | 'retry'
  | 'x';

const paths: Record<IconName, ReactNode> = {
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  eraser: (
    <>
      <path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </>
  ),
  fill: (
    <>
      <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0Z" />
      <path d="m5 2 5 5" />
      <path d="M2 13h15" />
      <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" />
    </>
  ),
  picker: (
    <>
      <path d="m2 22 1-1h3l9-9" />
      <path d="M3 21v-3l9-9" />
      <path d="m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L18 9l.4.4a2.1 2.1 0 0 1-3 3l-3.8-3.8a2.1 2.1 0 0 1 3-3Z" />
    </>
  ),
  line: <path d="M5 19 19 5" />,
  circle: <circle cx="12" cy="12" r="8" />,
  rect: <rect x="4" y="4" width="16" height="16" rx="1" />,
  diamond: <path d="M12 3 21 12 12 21 3 12Z" />,
  select: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
    </>
  ),
  pan: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </>
  ),
  redo: (
    <>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
    </>
  ),
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  fit: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    </>
  ),
  zoom: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m14.5 14.5 5 5M10 7.5v5M7.5 10h5" />
    </>
  ),
  grid: (
    <>
      <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
    </>
  ),
  checker: (
    <>
      <path d="M4 4h7v7H4z" fill="currentColor" stroke="none" />
      <path d="M13 13h7v7h-7z" fill="currentColor" stroke="none" />
      <path d="M13 4h7v7h-7zM4 13h7v7H4z" />
    </>
  ),
  axisV: <path d="M12 3v18M8 8h8M8 16h8" />,
  axisH: <path d="M3 12h18M8 8v8M16 8v8" />,
  eye: (
    <>
      <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  snapEdge: (
    <>
      <path d="M4 6h6v12H4zM14 6h6v12h-6zM11 9v6" />
    </>
  ),
  snapCenter: (
    <>
      <path d="M6 6h12v12H6z" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  crosshair: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>
  ),
  copy: (
    <>
      <path d="M8 8h12v12H8z" />
      <path d="M4 16V5a1 1 0 0 1 1-1h11" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <path d="m20 4-9 9M11 11 20 20" />
    </>
  ),
  paste: (
    <>
      <path d="M7 6h10v15H7z" />
      <path d="M9 6V4h6v2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="m7 7 1 13h8l1-13" />
    </>
  ),
  image: (
    <>
      <path d="M4 6h16v12H4z" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" stroke="none" />
      <path d="m4 16 5-4 4 3 3-2 4 3" />
    </>
  ),
  file: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  cloud: <path d="M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.6A3.5 3.5 0 0 0 7 18Z" />,
  check: <path d="m5 12 5 5L20 7" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  retry: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v6h-6" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
