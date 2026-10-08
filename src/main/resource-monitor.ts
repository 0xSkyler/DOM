import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Resources } from '../shared/types';
const exec = promisify(execFile);
export class ResourceMonitor {
  private last = new Map<number, number>();
  private lastAt = 0;
  async sample(): Promise<Resources> {
    const now = Date.now();
    let rows: { pid: number; parent: number; memory: number; cpuMs: number }[] = [];
    if (process.platform === 'linux') {
      const pids = (await readdir('/proc')).filter(x => /^\d+$/.test(x));
      rows = (await Promise.all(pids.map(async pid => {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          return { pid: +pid, parent: +fields[1], memory: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024, cpuMs: (+fields[11] + +fields[12]) * 10 };
        } catch { return undefined; }
      }))).filter(x => x !== undefined);
    } else if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      rows = JSON.parse(stdout).map((p: Record<string, number>) => ({ pid: Number(p.ProcessId), parent: Number(p.ParentProcessId), memory: Number(p.WorkingSetSize), cpuMs: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 10000 }));
    } else {
      const used = process.cpuUsage();
      rows = [{ pid: process.pid, parent: 0, memory: process.memoryUsage().rss, cpuMs: (used.user + used.system) / 1000 }];
    }
    const selected = new Set([process.pid]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; } }
    const owned = rows.filter(r => selected.has(r.pid));
    let pssBytes: number | undefined;
    if (process.platform === 'linux') {
      const sizes = await Promise.all(owned.map(async p => {
        try { const text = await readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8'); const size = text.match(/^Pss:\s+(\d+)/m); return size ? Number(size[1]) * 1024 : undefined; }
        catch (error) { return ['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException).code)) ? 0 : undefined; }
      }));
      if (sizes.every(size => size !== undefined)) pssBytes = sizes.reduce((sum: number, size) => sum + size!, 0);
    }
    const cpuDelta = owned.reduce((sum, p) => sum + Math.max(0, p.cpuMs - (this.last.get(p.pid) ?? (this.lastAt ? 0 : p.cpuMs))), 0);
    const cpuPercent = this.lastAt ? cpuDelta / (now - this.lastAt) * 100 : 0;
    this.last = new Map(owned.map(p => [p.pid, p.cpuMs])); this.lastAt = now;
    return { cpuPercent, rssBytes: owned.reduce((sum, p) => sum + p.memory, 0), pssBytes, systemUsedBytes: os.totalmem() - os.freemem(), systemTotalBytes: os.totalmem(), processCount: owned.length };
  }
}
