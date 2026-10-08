import { freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';

export function actualMemoryUsage(): { usedBytes: number; totalBytes: number } {
  const host = { usedBytes: totalmem() - freemem(), totalBytes: totalmem() };
  if (process.platform === 'linux') {
    try {
      const limit = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
      const used = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used >= 0 && limit < host.totalBytes)
        return { usedBytes: used, totalBytes: limit };
    } catch { /* Noncontainer hosts use the OS measurement. */ }
  }
  return host;
}
