import { toPng, toSvg } from 'html-to-image';

export interface ImageFrame {
  width: number;
  height: number;
  transform: string; // translate(x,y) scale(z) applied to the viewport for framing
}

// Snapshot the React Flow viewport element to a PNG/SVG data URL. The caller
// computes `frame` from the node bounds (so the whole graph is framed, not just
// the visible viewport) and passes the viewport element to rasterize.
export async function exportErImage(
  format: 'png' | 'svg',
  viewportEl: HTMLElement,
  frame: ImageFrame,
): Promise<string> {
  const opts = {
    backgroundColor: '#ffffff',
    width: frame.width,
    height: frame.height,
    style: {
      width: `${frame.width}px`,
      height: `${frame.height}px`,
      transform: frame.transform,
    },
  };
  return format === 'png' ? toPng(viewportEl, opts) : toSvg(viewportEl, opts);
}

// Trigger a browser download for a data URL (images). Text exports use the
// blob-based download() from gridFormat instead.
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
