import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StateFile {
  writes: Record<string, number>;
  lastWriteAt: number;
}

export interface AuditEntry {
  tool: string;
  event_id?: string;
  target?: string;
  detail?: string;
}

export class WriteGate {
  private state: StateFile;
  private queue: Promise<void> = Promise.resolve();
  private readonly statePath: string;
  private readonly auditPath: string;

  constructor(
    private readonly stateDir: string,
    private readonly maxWritesPerHour: number,
    private readonly minWriteIntervalMs: number,
    private readonly dedupeWindowMs: number,
  ) {
    this.statePath = join(stateDir, 'state.json');
    this.auditPath = join(stateDir, 'audit.jsonl');
    this.state = this.load();
  }

  private load(): StateFile {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.statePath)) {
      return { writes: {}, lastWriteAt: 0 };
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as StateFile).writes !== 'object' ||
        (parsed as StateFile).writes === null ||
        typeof (parsed as StateFile).lastWriteAt !== 'number'
      ) {
        throw new Error('invalid shape');
      }
      return parsed as StateFile;
    } catch {
      throw new Error(`cannot read write state at ${this.statePath}; fix or remove it`);
    }
  }

  private save(): void {
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  private purge(now: number): void {
    for (const [key, timestamp] of Object.entries(this.state.writes)) {
      if (now - timestamp > this.dedupeWindowMs) {
        delete this.state.writes[key];
      }
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  check(key: string, now = Date.now()): void {
    this.purge(now);
    if (this.state.writes[key] !== undefined) {
      throw new Error('duplicate write rejected: this content was already published recently');
    }
    const recent = Object.values(this.state.writes).filter((timestamp) => now - timestamp < 60 * 60 * 1_000);
    if (recent.length >= this.maxWritesPerHour) {
      throw new Error(`write rate limit reached (${this.maxWritesPerHour} per hour)`);
    }
    if (now - this.state.lastWriteAt < this.minWriteIntervalMs) {
      throw new Error('write rate limit reached: wait before publishing again');
    }
  }

  record(key: string, now = Date.now()): void {
    this.state.writes[key] = now;
    this.state.lastWriteAt = now;
    this.save();
  }

  audit(entry: AuditEntry): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(this.auditPath, `${line}\n`, { mode: 0o600 });
  }
}
