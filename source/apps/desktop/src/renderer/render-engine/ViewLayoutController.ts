import { parseReplayColor } from "./ReplayColor";
import type { ReplayViewport } from "./ReplayViewport";
import type { ReplayViewId } from "./ReplayScene";

type ViewKind = "map" | "orthographic";

export interface ReplayViewRegistration {
  readonly id: ReplayViewId;
  readonly kind: ViewKind;
  readonly selector?: string;
  readonly backdropSelector?: string;
}

const defaultViews: readonly ReplayViewRegistration[] = [
  {id: "map", kind: "map"},
  {id: "timeline", kind: "orthographic", selector: ".timeline-metric-plot", backdropSelector: ".timeline"},
  {id: "timeline-density", kind: "orthographic", selector: ".timeline-density-strips", backdropSelector: ".timeline"},
  {id: "elevation", kind: "orthographic", selector: ".route-elevation-plot", backdropSelector: ".route-elevation"},
];

const rectWithin = (root: DOMRect, element: DOMRect) => ({
  x: Math.max(0, element.left - root.left),
  y: Math.max(0, element.top - root.top),
  width: Math.max(0, Math.min(root.right, element.right) - Math.max(root.left, element.left)),
  height: Math.max(0, Math.min(root.bottom, element.bottom) - Math.max(root.top, element.top)),
});

export class ViewLayoutController {
  private readonly registrations = new Map<ReplayViewId, ReplayViewRegistration>();
  private readonly resizeObserver: ResizeObserver;
  private readonly mutationObserver: MutationObserver;
  private frame: number | null = null;
  private readonly observed = new Set<Element>();
  private destroyed = false;

  constructor(
    private readonly surface: HTMLElement,
    private readonly onChange: (views: readonly ReplayViewport[]) => void,
    registrations: readonly ReplayViewRegistration[] = defaultViews,
  ) {
    for (const registration of registrations) this.registrations.set(registration.id, registration);
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.mutationObserver = new MutationObserver(() => this.observeAndMeasure());
    const scope = surface.parentElement ?? surface;
    this.mutationObserver.observe(scope, {subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"]});
    this.observeAndMeasure();
  }

  register(registration: ReplayViewRegistration) {
    this.registrations.set(registration.id, registration);
    this.observeAndMeasure();
    return () => {
      this.registrations.delete(registration.id);
      this.observeAndMeasure();
    };
  }

  destroy() {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    this.observed.clear();
  }

  private observeAndMeasure() {
    if (this.destroyed) return;
    const scope = this.surface.parentElement ?? this.surface;
    const next = new Set<Element>([this.surface, scope]);
    for (const registration of this.registrations.values()) {
      for (const selector of [registration.selector, registration.backdropSelector]) {
        if (!selector) continue;
        const element = scope.querySelector<HTMLElement>(selector);
        if (element) next.add(element);
      }
    }
    for (const element of this.observed) if (!next.has(element)) {
      this.resizeObserver.unobserve(element);
      this.observed.delete(element);
    }
    for (const element of next) if (!this.observed.has(element)) {
      this.resizeObserver.observe(element);
      this.observed.add(element);
    }
    this.schedule();
  }

  private schedule() {
    if (this.destroyed) return;
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.onChange(this.measure());
    });
  }

  private measure(): readonly ReplayViewport[] {
    const root = this.surface.getBoundingClientRect();
    const scope = this.surface.parentElement ?? this.surface;
    const views: ReplayViewport[] = [];

    for (const registration of this.registrations.values()) {
      if (!registration.selector) {
        views.push({id: registration.id, kind: registration.kind, x: 0, y: 0, width: root.width, height: root.height});
        continue;
      }

      const element = scope.querySelector<HTMLElement>(registration.selector);
      if (!element || element.hidden || element.offsetParent === null) continue;
      const rect = rectWithin(root, element.getBoundingClientRect());
      if (rect.width === 0 || rect.height === 0) continue;
      const backdropElement = registration.backdropSelector ? scope.querySelector<HTMLElement>(registration.backdropSelector) : null;
      const color = backdropElement ? parseReplayColor(getComputedStyle(backdropElement).getPropertyValue("--replay-view-background")) : null;
      const backdrop = backdropElement && color ? {...rectWithin(root, backdropElement.getBoundingClientRect()), color} : undefined;
      views.push({...rect, id: registration.id, kind: registration.kind, ...(backdrop ? {backdrop} : {})});
    }

    return views;
  }
}
