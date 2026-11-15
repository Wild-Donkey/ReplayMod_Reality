import {MINIMAP_TRAJECTORY_COLOR} from "./MinimapTrail";
export const MINIMAP_SIZE = 360;

const FEATHER = 24;
const surfaces = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

/** Compose and feather the whole map, including roads, rather than its background alone. */
export function drawCircularMinimap(
  target: CanvasRenderingContext2D,
  navigation: HTMLCanvasElement | null,
  annotations: HTMLCanvasElement | null,
  bearing: number,
) {
  const pixels = Math.max(1, Math.round(MINIMAP_SIZE * target.getTransform().a));
  let canvas = surfaces.get(target);
  if (!canvas) { canvas = document.createElement("canvas"); surfaces.set(target, canvas); }
  if (canvas.width !== pixels || canvas.height !== pixels) { canvas.width = pixels; canvas.height = pixels; }
  const context = canvas.getContext("2d")!;
  context.setTransform(1,0,0,1,0,0);
  context.clearRect(0,0,pixels,pixels);
  const scale = pixels / MINIMAP_SIZE;
  context.setTransform(scale,0,0,scale,0,0);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "rgba(14, 20, 26, 0.58)";
  context.fillRect(0,0,MINIMAP_SIZE,MINIMAP_SIZE);
  if (navigation) context.drawImage(navigation,0,0,MINIMAP_SIZE,MINIMAP_SIZE);
  if (annotations) context.drawImage(annotations,0,0,MINIMAP_SIZE,MINIMAP_SIZE);
  const center = MINIMAP_SIZE / 2;
  context.globalCompositeOperation = "destination-in";
  const mask = context.createRadialGradient(center,center,center-FEATHER,center,center,center);
  mask.addColorStop(0,"rgba(0,0,0,1)");
  mask.addColorStop(.35,"rgba(0,0,0,.85)");
  mask.addColorStop(.7,"rgba(0,0,0,.35)");
  mask.addColorStop(1,"rgba(0,0,0,0)");
  context.fillStyle = mask;
  context.fillRect(0,0,MINIMAP_SIZE,MINIMAP_SIZE);
  context.globalCompositeOperation = "source-over";
  context.fillStyle = MINIMAP_TRAJECTORY_COLOR;
  context.globalAlpha = 1;
  context.shadowBlur = 0;
  context.beginPath();
  context.moveTo(center,center-14);
  context.lineTo(center+10,center+11);
  context.lineTo(center,center+6);
  context.lineTo(center-10,center+11);
  context.closePath();context.fill();
  context.shadowBlur = 0;
  target.save();
  target.shadowBlur = 0;
  target.globalAlpha = 1;
  target.drawImage(canvas,60,662,MINIMAP_SIZE,MINIMAP_SIZE);
  // The compass sits across the circle's boundary, outside the feather mask.
  // Rotate its positions and glyphs with the map's world, not the camera arrow.
  target.translate(60+center,662+center);
  target.rotate(-bearing*Math.PI/180);
  target.globalAlpha = 1;
  target.font = "700 22px sans-serif";
  target.textAlign = "center";
  target.textBaseline = "middle";
  target.lineWidth = 3;
  target.lineJoin = "round";
  target.strokeStyle = "rgba(0,0,0,.85)";
  for (const [label, direction] of [["N",0],["E",90],["S",180],["W",270]] as const) {
    const angle = direction*Math.PI/180-Math.PI/2;
    const x = Math.cos(angle)*center, y = Math.sin(angle)*center;
    target.fillStyle = label === "N" ? "#ff4a40" : "white";
    target.strokeText(label,x,y);
    target.fillText(label,x,y);
  }
  target.restore();
}
