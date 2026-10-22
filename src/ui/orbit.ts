import { add, cross, distance, normalize, scale, sub, type Vec3 } from '../math/vec3';
import type { Camera } from '../scene/scene';

export interface OrbitEvents {
  /** Fired continuously while the camera moves. */
  onChange: (camera: Camera) => void;
  /** Fired on a click without drag; `(x, y)` in client coordinates. */
  onClick: (x: number, y: number) => void;
}

/**
 * Orbit / pan / dolly controls that mutate a `Camera` in place.
 *
 *   drag              orbit around the target
 *   shift/right drag  pan
 *   wheel             dolly
 *   click             (delegated; used for focus picking)
 */
export class OrbitControls {
  private theta = 0;
  private phi = 0;
  private radius = 1;
  private dragging: 'orbit' | 'pan' | null = null;
  private last = { x: 0, y: 0 };
  private moved = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly el: HTMLElement,
    private camera: Camera,
    private readonly events: OrbitEvents,
  ) {
    this.syncFromCamera();
    const { signal } = this.abort;
    el.addEventListener('pointerdown', this.onPointerDown, { signal });
    el.addEventListener('pointermove', this.onPointerMove, { signal });
    el.addEventListener('pointerup', this.onPointerUp, { signal });
    el.addEventListener('pointercancel', this.onPointerUp, { signal });
    el.addEventListener('wheel', this.onWheel, { signal, passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  }

  /** Point the controls at a different camera (e.g. after switching scenes). */
  setCamera(camera: Camera): void {
    this.camera = camera;
    this.syncFromCamera();
  }

  private syncFromCamera(): void {
    const offset = sub(this.camera.position, this.camera.target);
    this.radius = Math.max(1e-3, distance(this.camera.position, this.camera.target));
    this.phi = Math.acos(Math.max(-1, Math.min(1, offset[1] / this.radius)));
    this.theta = Math.atan2(offset[0], offset[2]);
  }

  private applyToCamera(): void {
    const sinPhi = Math.sin(this.phi);
    const offset: Vec3 = [
      this.radius * sinPhi * Math.sin(this.theta),
      this.radius * Math.cos(this.phi),
      this.radius * sinPhi * Math.cos(this.theta),
    ];
    this.camera.position = add(this.camera.target, offset);
    this.events.onChange(this.camera);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
    this.el.setPointerCapture(e.pointerId);
    this.dragging = e.button === 0 && !e.shiftKey ? 'orbit' : 'pan';
    this.last = { x: e.clientX, y: e.clientY };
    this.moved = 0;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    this.moved += Math.abs(dx) + Math.abs(dy);

    if (this.dragging === 'orbit') {
      const k = (2 * Math.PI) / this.el.clientHeight;
      this.theta -= dx * k;
      this.phi = Math.max(0.02, Math.min(Math.PI - 0.02, this.phi - dy * k));
    } else {
      const forward = normalize(sub(this.camera.target, this.camera.position));
      const right = normalize(cross(forward, [0, 1, 0]));
      const up = cross(right, forward);
      const k = (this.radius * Math.tan((this.camera.fov * Math.PI) / 360) * 2) / this.el.clientHeight;
      const delta = add(scale(right, -dx * k), scale(up, dy * k));
      this.camera.target = add(this.camera.target, delta);
    }
    this.applyToCamera();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.el.releasePointerCapture(e.pointerId);
    const wasClick = this.moved < 3 && this.dragging === 'orbit';
    this.dragging = null;
    if (wasClick) this.events.onClick(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0012);
    this.radius = Math.max(0.05, Math.min(500, this.radius * factor));
    this.applyToCamera();
  };

  dispose(): void {
    this.abort.abort();
  }
}
