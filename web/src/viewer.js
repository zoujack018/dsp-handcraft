// SVG 视口：坐标保持原样，仅改变观察范围；触控与鼠标共用相机。
// 用户 2026-10-04：在页面上往下滑时图会跟着放大，很不方便。所以平时（预览）滚轮和触屏都交给页面滚动，
// 只有「大图」铺满时滚轮、双指才缩放；按钮、键盘缩放和鼠标拖动平移任何时候都能用。
export function zoomAround(camera, factor, anchor, width, height, fitScale) {
  const next = Math.min(24, Math.max(0.35, camera.zoom * factor));
  const before = fitScale * camera.zoom, after = fitScale * next;
  return {
    x: camera.x + (anchor.x - width / 2) * (1 / before - 1 / after),
    y: camera.y + (anchor.y - height / 2) * (1 / before - 1 / after),
    zoom: next,
  };
}

export function createViewer({ box, enabled, onSelect, onClear, onZoom, zoomable = () => true }) {
  let svg = null, base = null, camera = null;
  const pointers = new Map();
  const fitScale = () => Math.max(0.01, Math.min((box.clientWidth - 36) / base.width, (box.clientHeight - 36) / base.height));
  const local = (event) => { const rect = box.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  function refresh() {
    if (!enabled() || !svg || !camera || !box.clientWidth || !box.clientHeight) return;
    const scale = fitScale() * camera.zoom;
    const width = box.clientWidth / scale, height = box.clientHeight / scale;
    svg.setAttribute('viewBox', `${camera.x - width / 2} ${camera.y - height / 2} ${width} ${height}`);
    svg.style.width = `${box.clientWidth}px`;
    svg.style.height = `${box.clientHeight}px`;
    onZoom(Math.round(camera.zoom * 100));
  }
  function fit() {
    if (!base) return;
    camera = { x: base.x + base.width / 2, y: base.y + base.height / 2, zoom: 1 };
    refresh();
  }
  function zoomBy(factor, anchor = { x: box.clientWidth / 2, y: box.clientHeight / 2 }) {
    if (!camera || !enabled()) return;
    camera = zoomAround(camera, factor, anchor, box.clientWidth, box.clientHeight, fitScale());
    refresh();
  }
  function pan(dx, dy) {
    const scale = fitScale() * camera.zoom;
    camera.x -= dx / scale;
    camera.y -= dy / scale;
    refresh();
  }
  box.addEventListener('wheel', (e) => {
    if (!enabled() || !svg || !zoomable()) return; // 预览时不拦滚轮，页面照常滚动
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1);
    zoomBy(Math.exp(-Math.max(-150, Math.min(150, delta)) * 0.003), local(e));
  }, { passive: false });
  box.addEventListener('pointerdown', (e) => {
    if (!enabled() || !svg || ![0, 1].includes(e.button)) return;
    if (e.pointerType === 'touch' && !zoomable()) return; // 预览时手指滑动是滚页面
    e.preventDefault();
    box.focus({ preventScroll: true });
    const point = local(e);
    pointers.set(e.pointerId, { ...point, start: point, moved: false, run: e.target.closest('[data-route-run]')?.dataset.routeRun, button: e.button });
    if (pointers.size > 1) for (const p of pointers.values()) p.moved = true;
    box.setPointerCapture(e.pointerId);
    box.classList.add('is-panning');
  });
  box.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || !enabled() || !camera) return;
    const before = [...pointers.values()].map((q) => ({ x: q.x, y: q.y }));
    const point = local(e), dx = point.x - p.x, dy = point.y - p.y;
    Object.assign(p, point);
    if (Math.hypot(p.x - p.start.x, p.y - p.start.y) > 4) p.moved = true;
    if (pointers.size === 1) { if (p.moved) pan(dx, dy); }
    else if (pointers.size === 2) {
      const after = [...pointers.values()];
      const center = (v) => ({ x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 });
      const distance = (v) => Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
      const a = center(before), b = center(after);
      if (distance(before) > 1) zoomBy(distance(after) / distance(before), a);
      pan(b.x - a.x, b.y - a.y);
    }
  });
  function release(e, cancelled = false) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    if (!pointers.size) box.classList.remove('is-panning');
    if (!cancelled && !p.moved && p.button === 0) p.run ? onSelect(p.run) : onClear();
  }
  box.addEventListener('pointerup', (e) => release(e));
  box.addEventListener('pointercancel', (e) => release(e, true));
  box.addEventListener('keydown', (e) => {
    if (!enabled() || !svg) return;
    const run = e.target.closest('[data-route-run]')?.dataset.routeRun;
    if (run && ['Enter', ' '].includes(e.key)) { e.preventDefault(); onSelect(run); return; }
    if (['+', '=', '-', '0', 'Home', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    if (['+', '='].includes(e.key)) zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
    else if (['0', 'Home'].includes(e.key)) fit();
    else if (e.key === 'Escape') onClear();
    else if (e.key === 'ArrowLeft') pan(50, 0);
    else if (e.key === 'ArrowRight') pan(-50, 0);
    else if (e.key === 'ArrowUp') pan(0, 50);
    else if (e.key === 'ArrowDown') pan(0, -50);
  });
  return {
    attach(element, reset = false) {
      svg = element;
      const b = svg.viewBox.baseVal;
      base = { x: b.x, y: b.y, width: b.width, height: b.height };
      if (!camera || reset) fit(); else refresh();
    },
    fit, zoomBy, refresh,
    reset() { camera = null; svg = null; },
  };
}
