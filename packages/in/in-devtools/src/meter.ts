import type { InspectorMeter } from './types.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

export function meterSnapshot(meter: InspectorMeter | undefined): MeterSnapshot | null {
  return meter ? meter.snapshot() : null
}
