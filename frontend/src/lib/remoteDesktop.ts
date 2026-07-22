export type DevicePoint = { x: number; y: number };

export type ViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Maps a browser pointer through object-contain letterboxing to Android pixels. */
export function mapPointerToDevice(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
  screenW: number,
  screenH: number,
  contentAspect: number,
): DevicePoint | null {
  if (
    !Number.isFinite(clientX)
    || !Number.isFinite(clientY)
    || !Number.isFinite(screenW)
    || !Number.isFinite(screenH)
    || !Number.isFinite(contentAspect)
    || screenW < 2
    || screenH < 2
    || rect.width <= 0
    || rect.height <= 0
    || contentAspect <= 0
  ) return null;

  const containerAspect = rect.width / rect.height;
  let renderW: number;
  let renderH: number;
  let offsetX: number;
  let offsetY: number;
  if (containerAspect > contentAspect) {
    renderH = rect.height;
    renderW = renderH * contentAspect;
    offsetX = (rect.width - renderW) / 2;
    offsetY = 0;
  } else {
    renderW = rect.width;
    renderH = renderW / contentAspect;
    offsetX = 0;
    offsetY = (rect.height - renderH) / 2;
  }

  const x = clientX - rect.left - offsetX;
  const y = clientY - rect.top - offsetY;
  if (x < 0 || y < 0 || x > renderW || y > renderH) return null;

  return {
    x: Math.max(0, Math.min(screenW - 1, Math.round((x / renderW) * screenW))),
    y: Math.max(0, Math.min(screenH - 1, Math.round((y / renderH) * screenH))),
  };
}
