import { randomUUID } from 'node:crypto';

export type RealtimeMessage = {
  id: string;
  topic: string;
  sender: string;
  data: Record<string, any>;
  createdAt: number;
};
export type RealtimeHandler = (
  message: RealtimeMessage,
) => void | Promise<void>;
export interface RealtimeTransport {
  readonly instanceId: string;
  readonly ready?: Promise<void>;
  subscribe(
    topic: string,
    handler: RealtimeHandler,
  ): Promise<() => Promise<void>>;
  publish(topic: string, data: Record<string, any>): Promise<void>;
  close(): Promise<void>;
}
export interface RealtimeStore {
  db: object;
  one(sql: string, ...values: any[]): any | Promise<any>;
  all(sql: string, ...values: any[]): any[] | Promise<any[]>;
  exec(sql: string, ...values: any[]): any | Promise<any>;
  tx<T>(operation: () => Promise<T>): Promise<T>;
}

/** A SQL-backed fan-out log. Source transactions may append through the same ALS-bound connection. */
export class SqlRealtimeTransport implements RealtimeTransport {
  readonly instanceId: string;
  readonly ready: Promise<void>;
  private readonly handlers = new Map<string, Set<RealtimeHandler>>();
  private cursor: number | undefined;
  private starting?: Promise<void>;
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private cycles = 0;
  private epoch = 0;
  constructor(
    readonly store: RealtimeStore,
    readonly options: {
      instanceId?: string;
      pollMs?: number;
      retentionMs?: number;
    } = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private async initialize() {
    await this.store.tx(async () => {
      const lock = (
        this.store.db as { lock?: (key: string) => Promise<void> }
      ).lock;
      if (lock) await lock.call(this.store.db, 'schema:studio.realtime');
      await this.store.exec(
        'CREATE TABLE IF NOT EXISTS studio_realtime_clock(id INTEGER PRIMARY KEY,sequence BIGINT NOT NULL)',
      );
      await this.store.exec(
        'INSERT INTO studio_realtime_clock(id,sequence) VALUES(1,0) ON CONFLICT(id) DO NOTHING',
      );
      await this.store.exec(
        'CREATE TABLE IF NOT EXISTS studio_realtime_events(sequence BIGINT PRIMARY KEY,id TEXT UNIQUE NOT NULL,topic TEXT NOT NULL,sender TEXT NOT NULL,payload TEXT NOT NULL,created_at BIGINT NOT NULL)',
      );
      await this.store.exec(
        'CREATE INDEX IF NOT EXISTS studio_realtime_topic ON studio_realtime_events(topic,sequence)',
      );
    });
  }
  private async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.ready;
      if (this.cursor === undefined)
        this.cursor = Number(
          (
            await this.store.one(
              'SELECT sequence FROM studio_realtime_clock WHERE id=1',
            )
          ).sequence,
        );
      if (!this.timer && !this.closed) {
        this.timer = setInterval(() => {
          void this.poll().catch(() => {});
        }, this.options.pollMs ?? 250);
        this.timer.unref();
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  async subscribe(topic: string, handler: RealtimeHandler) {
    if (this.closed) throw new Error('Realtime transport is closed');
    if (!/^[a-z-]+:[A-Za-z0-9_-]{1,100}$/.test(topic))
      throw new Error('Invalid realtime topic');
    await this.start();
    let group = this.handlers.get(topic);
    if (!group) {
      group = new Set();
      this.handlers.set(topic, group);
    }
    group.add(handler);
    return async () => {
      group!.delete(handler);
      if (!group!.size) this.handlers.delete(topic);
      if (!this.handlers.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.cursor = undefined;
        this.epoch++;
      }
    };
  }
  async publish(topic: string, data: Record<string, any>) {
    if (this.closed) throw new Error('Realtime transport is closed');
    if (!/^[a-z-]+:[A-Za-z0-9_-]{1,100}$/.test(topic))
      throw new Error('Invalid realtime topic');
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > 128 * 1024)
      throw new Error('Realtime metadata exceeded its size limit');
    await this.ready;
    await this.store.tx(async () => {
      // A locked transactional clock orders commits. A nontransactional sequence alone could skip late commits.
      const row = await this.store.one(
        'UPDATE studio_realtime_clock SET sequence=sequence+1 WHERE id=1 RETURNING sequence',
      );
      await this.store.exec(
        'INSERT INTO studio_realtime_events(sequence,id,topic,sender,payload,created_at) VALUES(?,?,?,?,?,?)',
        row.sequence,
        randomUUID(),
        topic,
        this.instanceId,
        payload,
        Date.now(),
      );
    });
  }
  async poll() {
    if (
      this.polling ||
      this.closed ||
      this.cursor === undefined ||
      !this.handlers.size
    )
      return this.polling;
    this.polling = this.read();
    try {
      await this.polling;
    } finally {
      this.polling = undefined;
    }
  }
  private async read() {
    const epoch = this.epoch;
    const first = await this.store.one(
      'SELECT min(sequence) AS sequence FROM studio_realtime_events',
    );
    if (epoch !== this.epoch || this.closed) return;
    if (
      first?.sequence !== null &&
      Number(first.sequence) > this.cursor! + 1
    ) {
      this.cursor = Number(first.sequence) - 1;
      for (const [topic, group] of this.handlers)
        for (const handler of group)
          await handler({
            id: 'reset-' + randomUUID(),
            topic,
            sender: this.instanceId,
            data: { type: 'reset' },
            createdAt: Date.now(),
          });
    }
    for (let page = 0; page < 4; page++) {
      if (epoch !== this.epoch || this.closed) return;
      const rows = await this.store.all(
        'SELECT sequence,id,topic,sender,payload,created_at FROM studio_realtime_events WHERE sequence>? ORDER BY sequence LIMIT 100',
        this.cursor,
      );
      if (epoch !== this.epoch || this.closed) return;
      if (!rows.length) break;
      for (const row of rows) {
        if (epoch !== this.epoch || this.closed) return;
        if (row.sender !== this.instanceId) {
          const message: RealtimeMessage = {
            id: row.id,
            topic: row.topic,
            sender: row.sender,
            data: JSON.parse(row.payload),
            createdAt: Number(row.created_at),
          };
          for (const handler of [...(this.handlers.get(row.topic) ?? [])])
            await handler(message);
        }
        this.cursor = Number(row.sequence);
      }
      if (rows.length < 100) break;
    }
    if (++this.cycles % 40 === 0)
      await this.store.exec(
        'DELETE FROM studio_realtime_events WHERE created_at<? AND sequence<=?',
        Date.now() - (this.options.retentionMs ?? 300000),
        this.cursor,
      );
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.polling?.catch(() => {});
    await this.ready.catch(() => {});
    this.handlers.clear();
  }
}
