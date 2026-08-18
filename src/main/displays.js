'use strict';

const { screen } = require('electron/main');

// Single source of truth for the smallest usable selection. Previously the selector
// window enforced 32px, the main process 8px and the renderer 6% of the display, so a
// small region silently grew to something the user had not drawn.
const MIN_SELECTION_PX = 16;

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDisplayPayload() {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;

  const minX = Math.min(...displays.map((display) => display.bounds.x));
  const minY = Math.min(...displays.map((display) => display.bounds.y));
  const maxX = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const maxY = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    minSelectionPx: MIN_SELECTION_PX,
    virtualBounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    },
    displays: displays.map((display, index) => ({
      id: String(display.id),
      index: index + 1,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryId
    }))
  };
}

function rectIntersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y)
  };
}

/**
 * Maps an absolute desktop rectangle onto one display. Cross-monitor selections are
 * rejected instead of silently discarding the portion outside the largest intersection.
 */
function normalizeDesktopArea(rect) {
  if (!rect || rect.width < MIN_SELECTION_PX || rect.height < MIN_SELECTION_PX) return null;

  const { displays } = getDisplayPayload();
  const display = displays.find((item) => (
    rect.x >= item.bounds.x
    && rect.y >= item.bounds.y
    && rect.x + rect.width <= item.bounds.x + item.bounds.width
    && rect.y + rect.height <= item.bounds.y + item.bounds.height
  ));
  if (!display) return null;

  return {
    displayId: display.id,
    display,
    absolute: { ...rect },
    selection: {
      x: clampNumber((rect.x - display.bounds.x) / display.bounds.width, 0, 1),
      y: clampNumber((rect.y - display.bounds.y) / display.bounds.height, 0, 1),
      width: clampNumber(rect.width / display.bounds.width, 0, 1),
      height: clampNumber(rect.height / display.bounds.height, 0, 1)
    }
  };
}

module.exports = {
  MIN_SELECTION_PX,
  clampNumber,
  getDisplayPayload,
  rectIntersection,
  normalizeDesktopArea
};
