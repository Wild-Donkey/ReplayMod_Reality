import type { ReplayScene, ReplaySceneSnapshot } from "./ReplayScene";
import type { RenderLayerId } from "./LayerVisibility";

export interface ReplayRenderChannel {
  readonly id: string;
  readonly group: RenderLayerId;
  setVisible(visible: boolean): void;
  update?(snapshot: ReplaySceneSnapshot): void;
  dispose(): void;
}

// A common lifecycle for DOM, MapLibre and GPU passes. Each backend keeps its
// drawing primitives; shared state owns visibility and teardown.
export class RenderChannelRegistry {
  private readonly channels = new Map<string, ReplayRenderChannel>();
  private readonly visible = new Map<string, boolean>();
  private readonly unsubscribe: () => void;
  private destroyed = false;

  constructor(private readonly scene: ReplayScene) {
    this.unsubscribe = scene.subscribe(snapshot => {
      for (const channel of this.channels.values()) this.apply(channel, snapshot);
    });
  }

  register(channel: ReplayRenderChannel) {
    if (this.destroyed) throw new Error("Cannot register a channel after registry destruction");
    if (this.channels.has(channel.id)) throw new Error(`Render channel already registered: ${channel.id}`);
    this.channels.set(channel.id, channel);
    try { this.apply(channel, this.scene.current); }
    catch (error) {
      this.channels.delete(channel.id);
      this.visible.delete(channel.id);
      try { channel.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `Render channel failed: ${channel.id}`); }
      throw error;
    }
    return () => {
      if (this.channels.get(channel.id) !== channel) return;
      this.channels.delete(channel.id);
      this.visible.delete(channel.id);
      channel.dispose();
    };
  }

  refresh() {
    if (this.destroyed) return;
    this.visible.clear();
    for (const channel of this.channels.values()) this.apply(channel, this.scene.current);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    const channels = [...this.channels.values()];
    this.channels.clear();
    this.visible.clear();
    const errors: unknown[] = [];
    for (const channel of channels) {
      try { channel.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Render channel cleanup failed");
  }

  private apply(channel: ReplayRenderChannel, snapshot: ReplaySceneSnapshot) {
    const visible = snapshot.visibility[channel.group];
    if (this.visible.get(channel.id) !== visible) {
      this.visible.set(channel.id, visible);
      channel.setVisible(visible);
    }
    channel.update?.(snapshot);
  }
}
