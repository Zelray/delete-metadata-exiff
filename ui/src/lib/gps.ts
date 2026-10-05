import type { GpsInfo } from '@metadesk/shared';

/**
 * GPS presentation helpers. Per the UX spec, GPS renders as a human
 * coordinate line plus an "Open map" link (OpenStreetMap in the browser) and
 * a copy-coordinates action — never as raw DMS strings.
 */

/** 41.2044 -> { value: 41.2044, hemisphere: 'N' } */
export function splitCoordinate(
  decimal: number,
  axis: 'lat' | 'lon',
): { value: number; hemisphere: string } {
  const positive = axis === 'lat' ? 'N' : 'E';
  const negative = axis === 'lat' ? 'S' : 'W';
  return {
    value: Math.abs(decimal),
    hemisphere: decimal >= 0 ? positive : negative,
  };
}

/** 41.2044 -> `41° 12' 16" N` style, 1" precision. */
export function toDms(decimal: number, axis: 'lat' | 'lon'): string {
  const { value, hemisphere } = splitCoordinate(decimal, axis);
  const degrees = Math.floor(value);
  const minutesFloat = (value - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${degrees}° ${mm}' ${ss}" ${hemisphere}`;
}

/** "41.204 N, 75.991 W" — the one-line coordinate string the spec shows. */
export function formatGpsLine(gps: GpsInfo): string {
  const lat = splitCoordinate(gps.latitude, 'lat');
  const lon = splitCoordinate(gps.longitude, 'lon');
  return `${lat.value.toFixed(3)}° ${lat.hemisphere}, ${lon.value.toFixed(3)}° ${lon.hemisphere}`;
}

/** Deep link straight onto the photo's spot. */
export function osmLink(gps: GpsInfo): string {
  const z = 15;
  return `https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=${z}/${gps.latitude}/${gps.longitude}`;
}

/** Clipboard-friendly "lat, lon" decimal pair. */
export function coordinatesForCopy(gps: GpsInfo): string {
  return `${gps.latitude}, ${gps.longitude}`;
}
