/**
 * This files contains functions that allow for tracking the amount of functions calls made to desired functions, as well as proxies for #DISK_WRITES and #DISK_READS
 */

const DEBUG_ENABLED = false;

export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}

export function debugLog(...args: unknown[]): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  console.log(...args);
}

/***********************************************************
 *                        DISK WRITES                      *
 **********************************************************/
const DEBUG_overwrite_sources: { [key: string]: number } = {};
const DEBUG_allocWrite_sources: { [key: string]: number } = {};
const DEBUG_write_counts: { [key: string]: number } = {
  'overwriteBlock()': 0,
  'allocateAndWrite()': 0,
  'allocateAndWriteMany()': 0,
  'commit()': 0,
};

export function debug_incrementOverwriteSource(source: string): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  const isNewKey = !Object.keys(DEBUG_overwrite_sources).includes(source);
  if (isNewKey) {
    DEBUG_overwrite_sources[source] = 0;
  }
  DEBUG_overwrite_sources[source] += 1;
}
export function debug_getOverwriteSources() {
  return { ...DEBUG_overwrite_sources };
}

export function debug_incrementAllocwriteSource(source: string): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  const isNewKey = !Object.keys(DEBUG_allocWrite_sources).includes(source);
  if (isNewKey) {
    DEBUG_allocWrite_sources[source] = 0;
  }
  DEBUG_allocWrite_sources[source] += 1;
}
export function debug_getAllocWriteSources() {
  return { ...DEBUG_allocWrite_sources };
}

export function debug_incrementWriteCounts(source: string): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  // Must be one of the hardcoded keys! Let it error if not.
  DEBUG_write_counts[source] += 1;
}

export function debug_getWriteCounts() {
  return { ...DEBUG_write_counts };
}

/***********************************************************
 *                        DISK READS                       *
 **********************************************************/
let DEBUG_disk_read_count = 0;

export function debug_incrementDiskReadCount() {
  if (!DEBUG_ENABLED) {
    return;
  }

  DEBUG_disk_read_count += 1;
}
export function debug_getDiskReadCount() {
  return DEBUG_disk_read_count;
}

/***********************************************************
 *                        OTHER                            *
 **********************************************************/
const DEBUG_fn_call_counts: { [key: string]: number } = {};

export function debug_incrementFnCallCount(source: string): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  const isNewKey = !Object.keys(DEBUG_fn_call_counts).includes(source);
  if (isNewKey) {
    DEBUG_fn_call_counts[source] = 0;
  }

  //
  DEBUG_fn_call_counts[source] += 1;
}
export function debug_getFnCallCounts() {
  return { ...DEBUG_fn_call_counts };
}
