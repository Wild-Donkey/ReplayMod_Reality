import {
  Body, Equator, EquatorFromVector, GeoVector, Horizon, Observer, RotateVector,
  Rotation_EQJ_EQD, SearchRiseSet, SiderealTime, Spherical, VectorFromSphere,
} from "astronomy-engine";

export type ObservationPoint = readonly [longitude: number, latitude: number];
export const minutesPerDay = 1440;
const minuteMs = 60_000;
const radians = Math.PI / 180;
export const firstDate = "1900-01-01";
export const lastDate = "2100-12-31";

export const skyObjects = [
  { id: "sun", label: "太阳", color: "#ffca6a" },
  { id: "moon", label: "月亮", color: "#9ddaff" },
  { id: "galacticCenter", label: "银心", color: "#e8afff" },
] as const;

export const twilightBands = [
  { label: "白昼", minAltitude: 0, opacity: 0 },
  { label: "民用曙暮光", minAltitude: -6, opacity: 0.16 },
  { label: "航海曙暮光", minAltitude: -12, opacity: 0.32 },
  { label: "天文曙暮光", minAltitude: -18, opacity: 0.49 },
  { label: "夜晚", minAltitude: -90, opacity: 0.66 },
] as const;

export type SkyObject = typeof skyObjects[number]["id"];
export type Direction = { altitude: number; azimuth: number };
type RiseSetEvent = { minute: number; azimuth: number };

export function observationStart(date: string, offsetMinutes: number) {
  return Date.parse(`${date}T00:00:00Z`) - offsetMinutes * minuteMs;
}

export function observationNow(offsetMinutes: number) {
  const clock = new Date(Date.now() + offsetMinutes * minuteMs);
  return { date: clock.toISOString().slice(0, 10), minute: clock.getUTCHours() * 60 + clock.getUTCMinutes() };
}

export function observationDateAfter(date: string, days: number) {
  return new Date(observationStart(date, 0) + days * minutesPerDay * minuteMs).toISOString().slice(0, 10);
}

export function formatMinute(minute: number) {
  const wholeMinute = Math.min(minutesPerDay, Math.round(minute));
  return `${String(Math.floor(wholeMinute / 60)).padStart(2, "0")}:${String(wholeMinute % 60).padStart(2, "0")}`;
}

export function formatOffset(minutes: number) {
  return `UTC${minutes < 0 ? "−" : "+"}${formatMinute(Math.abs(minutes))}`;
}

function toObserver([longitude, latitude]: ObservationPoint) {
  return new Observer(latitude, longitude, 0);
}

function bodyDirection(body: Body, time: Date, observer: Observer): Direction {
  const { ra, dec } = Equator(body, time, observer, true, true);
  return Horizon(time, observer, ra, dec, "normal");
}

export function skyDirections(time: Date, observer: Observer): Record<SkyObject, Direction> {
  // Sagittarius A*, used as the direction of the Galactic Centre (ICRS/J2000).
  const center = VectorFromSphere(new Spherical(-29.00781, 266.41684, 1), time);
  const { ra, dec } = EquatorFromVector(RotateVector(Rotation_EQJ_EQD(time), center));
  return {
    sun: bodyDirection(Body.Sun, time, observer),
    moon: bodyDirection(Body.Moon, time, observer),
    galacticCenter: Horizon(time, observer, ra, dec, "normal"),
  };
}

export function sunVector(time: Date): [number, number, number] {
  const sun = EquatorFromVector(RotateVector(Rotation_EQJ_EQD(time), GeoVector(Body.Sun, time, true)));
  const longitude = (sun.ra - SiderealTime(time)) * 15 * radians;
  const latitude = sun.dec * radians;
  return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
}

const horizonEvents = [
  { label: "日出", color: "#ffa254", direction: 1, target: Body.Sun },
  { label: "日落", color: "#ff706e", direction: -1, target: Body.Sun },
  { label: "月出", color: "#76dec0", direction: 1, target: Body.Moon },
  { label: "月落", color: "#7997ff", direction: -1, target: Body.Moon },
] as const;

export function observationDay(point: ObservationPoint, start: number) {
  const observer = toObserver(point);
  const samples = Array.from({ length: minutesPerDay / 5 + 1 }, (_, i) =>
    skyDirections(new Date(start + i * 5 * minuteMs), observer));
  const events = horizonEvents.map(({ label, color, direction, target }) => {
    const event = SearchRiseSet(target, observer, direction, new Date(start), 1);
    const minute = event ? (event.date.getTime() - start) / minuteMs : null;
    const value: RiseSetEvent | null = event && minute !== null && minute >= 0 && minute < minutesPerDay ? {
      minute, azimuth: bodyDirection(target, event.date, observer).azimuth,
    } : null;
    return { label, color, value };
  });
  return { observer, samples, events };
}

export type ObservationDay = ReturnType<typeof observationDay>;
export type AstronomyMapState = {
  point: ObservationPoint | null;
  sun: ReturnType<typeof sunVector>;
  directions: ReturnType<typeof skyDirections> | null;
  events: ObservationDay["events"];
};
