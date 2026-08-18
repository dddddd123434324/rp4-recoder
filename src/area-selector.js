'use strict';

/*
 * Region selector overlay. Spans the entire virtual desktop so a region can be drawn on
 * any monitor, and reports absolute desktop coordinates back to the main process.
 */

const selection = document.getElementById('selection');
const applyButton = document.getElementById('applyButton');
const cancelButton = document.getElementById('cancelButton');
const fillDisplayButton = document.getElementById('fillDisplayButton');
const hint = document.getElementById('hint');
const actions = document.getElementById('actions');

let virtualBounds = { x: 0, y: 0, width: 0, height: 0 };
let displayList = [];
let minSizePx = 16;
let rect = null;
let drag = null;

/**
 * CSS pixels in this window map onto virtual-desktop coordinates. The ratio is normally
 * 1, but deriving it keeps the mapping correct on mixed-DPI setups.
 */
function scale() {
  return {
    x: virtualBounds.width / Math.max(1, window.innerWidth),
    y: virtualBounds.height / Math.max(1, window.innerHeight)
  };
}

function toClient(absoluteX, absoluteY) {
  const s = scale();
  return {
    x: (absoluteX - virtualBounds.x) / (s.x || 1),
    y: (absoluteY - virtualBounds.y) / (s.y || 1)
  };
}

function minSizeClient() {
  const s = scale();
  return {
    width: minSizePx / (s.x || 1),
    height: minSizePx / (s.y || 1)
  };
}

function displayAt(clientX, clientY) {
  const s = scale();
  const absoluteX = virtualBounds.x + clientX * s.x;
  const absoluteY = virtualBounds.y + clientY * s.y;

  return displayList.find((display) => (
    absoluteX >= display.bounds.x
    && absoluteX < display.bounds.x + display.bounds.width
    && absoluteY >= display.bounds.y
    && absoluteY < display.bounds.y + display.bounds.height
  )) || displayList.find((display) => display.primary) || displayList[0] || null;
}

/** Keeps the toolbars on whichever monitor the pointer is using. */
function positionChrome(clientX, clientY) {
  const display = displayAt(clientX, clientY);
  if (!display) return;

  const topLeft = toClient(display.bounds.x, display.bounds.y);
  const bottomRight = toClient(
    display.bounds.x + display.bounds.width,
    display.bounds.y + display.bounds.height
  );
  const centerX = (topLeft.x + bottomRight.x) / 2;

  hint.style.left = `${centerX - hint.offsetWidth / 2}px`;
  hint.style.top = `${topLeft.y + 26}px`;
  actions.style.left = `${bottomRight.x - actions.offsetWidth - 26}px`;
  actions.style.top = `${bottomRight.y - actions.offsetHeight - 26}px`;
}

function clientBoundsForDisplay(display) {
  if (!display) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const topLeft = toClient(display.bounds.x, display.bounds.y);
  const bottomRight = toClient(
    display.bounds.x + display.bounds.width,
    display.bounds.y + display.bounds.height
  );
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y
  };
}

function normalizeRect(value, display = null) {
  const limits = minSizeClient();
  const bounds = clientBoundsForDisplay(display);
  const width = Math.max(limits.width, Math.min(bounds.width, value.width));
  const height = Math.max(limits.height, Math.min(bounds.height, value.height));
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, value.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, value.y)),
    width,
    height
  };
}

function resizeRect(start, handle, dx, dy, display) {
  const limits = minSizeClient();
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;

  if (right - left < limits.width) {
    if (handle.includes('w')) left = right - limits.width;
    else right = left + limits.width;
  }
  if (bottom - top < limits.height) {
    if (handle.includes('n')) top = bottom - limits.height;
    else bottom = top + limits.height;
  }

  return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top }, display);
}

function drawSelection() {
  if (!rect) return;
  const s = scale();
  selection.classList.add('active');
  selection.style.left = `${rect.x}px`;
  selection.style.top = `${rect.y}px`;
  selection.style.width = `${rect.width}px`;
  selection.style.height = `${rect.height}px`;
  selection.dataset.size = `${Math.round(rect.width * s.x)} x ${Math.round(rect.height * s.y)}`;
}

function beginPointer(event) {
  if (event.button !== 0) return;
  if (event.target.closest('button')) return;

  const handle = event.target.dataset.handle || null;
  if (selection.contains(event.target) && rect) {
    drag = {
      mode: handle || 'move',
      display: displayAt(rect.x + rect.width / 2, rect.y + rect.height / 2),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: { ...rect }
    };
    selection.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return;
  }

  rect = { x: event.clientX, y: event.clientY, width: 1, height: 1 };
  drag = {
    mode: 'create',
    display: displayAt(event.clientX, event.clientY),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    rect: { ...rect }
  };
  selection.classList.add('active');
  drawSelection();
}

function movePointer(event) {
  positionChrome(event.clientX, event.clientY);
  if (!drag || event.pointerId !== drag.pointerId) return;

  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  const start = drag.rect;

  if (drag.mode === 'create') {
    rect = normalizeRect({
      x: Math.min(drag.startX, event.clientX),
      y: Math.min(drag.startY, event.clientY),
      width: Math.abs(dx),
      height: Math.abs(dy)
    }, drag.display);
  } else if (drag.mode === 'move') {
    rect = normalizeRect({ ...start, x: start.x + dx, y: start.y + dy }, drag.display);
  } else {
    rect = resizeRect(start, drag.mode, dx, dy, drag.display);
  }

  drawSelection();
}

function finishPointer(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  selection.releasePointerCapture?.(event.pointerId);
  const display = drag.display;
  drag = null;
  rect = normalizeRect(rect, display);
  drawSelection();
}

function fillDisplay() {
  const center = rect
    ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const display = displayAt(center.x, center.y);
  if (!display) return;

  const topLeft = toClient(display.bounds.x, display.bounds.y);
  const bottomRight = toClient(
    display.bounds.x + display.bounds.width,
    display.bounds.y + display.bounds.height
  );
  rect = normalizeRect({
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y
  }, display);
  drawSelection();
}

function applySelection() {
  if (!rect) return;
  const s = scale();
  window.rp4Area.complete({
    x: Math.round(virtualBounds.x + rect.x * s.x),
    y: Math.round(virtualBounds.y + rect.y * s.y),
    width: Math.round(rect.width * s.x),
    height: Math.round(rect.height * s.y)
  });
}

function cancelSelection() {
  window.rp4Area.cancel();
}

function handleKey(event) {
  if (event.key === 'Escape') cancelSelection();
  if (event.key === 'Enter') applySelection();
}

async function init() {
  const data = await window.rp4Area.getDisplayData();
  virtualBounds = data.virtualBounds;
  displayList = data.displays || [];
  minSizePx = data.minSelectionPx || 16;

  positionChrome(window.innerWidth / 2, window.innerHeight / 2);

  window.addEventListener('pointerdown', beginPointer);
  window.addEventListener('pointermove', movePointer);
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('keydown', handleKey);
  applyButton.addEventListener('click', applySelection);
  cancelButton.addEventListener('click', cancelSelection);
  fillDisplayButton.addEventListener('click', fillDisplay);
  selection.addEventListener('dblclick', applySelection);

  fillDisplay();
}

void init();
