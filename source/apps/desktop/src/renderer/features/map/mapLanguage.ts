import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { MapLanguage } from "../../../shared/settings";

const languageField = (language: MapLanguage) => {
  if (language === "local") return "name";
  if (language === "auto") {
    const browserLanguage = navigator.languages?.[0] ?? navigator.language;
    return browserLanguage.toLowerCase().startsWith("zh") ? "name:zh" : "name:en";
  }
  return `name:${language}`;
};

const localizedName = (field: string): ExpressionSpecification => field === "name"
  ? ["get", "name"]
  : ["coalesce", ["get", field], ["get", "name"]];

const localizeExpression = (value: unknown, field: string): unknown => {
  if (typeof value === "string") {
    return value.replace(/\{name(?::[^}]+)?\}/g, `{${field}}`);
  }
  if (!Array.isArray(value)) return value;
  if (value[0] === "get" && typeof value[1] === "string" && value[1].startsWith("name")) {
    return localizedName(field);
  }
  return value.map(item => localizeExpression(item, field));
};

export function applyMapLanguage(map: MapLibreMap, language: MapLanguage) {
  const field = languageField(language);
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type !== "symbol" || !layer.layout?.["text-field"]) continue;
    const textField = layer.layout["text-field"];
    if (!JSON.stringify(textField).includes("name")) continue;
    map.setLayoutProperty(layer.id, "text-field", localizeExpression(textField, field));
  }
}
