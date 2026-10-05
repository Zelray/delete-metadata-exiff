import { describe, expect, it } from 'vitest';
import type { GpsInfo } from '@metadesk/shared';
import { coordinatesForCopy, formatGpsLine, osmLink, splitCoordinate, toDms } from './gps';

const gps: GpsInfo = { latitude: 41.2044, longitude: -75.9911 };

describe('gps presentation', () => {
  it('formats the one-line coordinate string with hemispheres', () => {
    expect(formatGpsLine(gps)).toBe('41.204° N, 75.991° W');
  });

  it('converts to DMS', () => {
    expect(toDms(41.2044, 'lat')).toBe("41° 12' 16\" N");
    expect(toDms(-75.9911, 'lon')).toBe("75° 59' 28\" W");
  });

  it('splits sign into hemisphere', () => {
    expect(splitCoordinate(41.2, 'lat')).toEqual({ value: 41.2, hemisphere: 'N' });
    expect(splitCoordinate(-75.9, 'lon')).toEqual({ value: 75.9, hemisphere: 'W' });
    expect(splitCoordinate(12.0, 'lon')).toEqual({ value: 12, hemisphere: 'E' });
  });

  it('builds an OpenStreetMap deep link on the exact spot', () => {
    expect(osmLink(gps)).toBe(
      'https://www.openstreetmap.org/?mlat=41.2044&mlon=-75.9911#map=15/41.2044/-75.9911',
    );
  });

  it('produces a copyable decimal pair', () => {
    expect(coordinatesForCopy(gps)).toBe('41.2044, -75.9911');
  });
});
