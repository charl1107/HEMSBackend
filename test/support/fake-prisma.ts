/**
 * Fake PrismaService for tests.
 *
 * It implements the slice of the Prisma client surface the app actually uses,
 * backed by in-memory scripts instead of a database connection. Because the
 * provider is overridden in the Nest testing module, `PrismaClient` is never
 * instantiated by these tests: no connection is opened and the real database
 * cannot be reached, even by accident.
 *
 * Usage:
 *   const prisma = createFakePrisma();
 *   prisma.on('user.findUnique', { id: 'u1', ... });   // first call
 *   prisma.on('event.findMany', [eventRow]);           // every call
 *
 * Unscripted calls fall back to sensible Prisma-shaped defaults:
 *   findUnique / findFirst -> null, findMany -> [], count -> 0,
 *   create / update / upsert -> echo of the written data,
 *   delete -> the where clause, deleteMany / updateMany -> { count: 0 }.
 *
 * Caveat: the `create`/`update` echo is a flat merge of `where` + `data` and
 * therefore does NOT model Prisma relations (e.g. a `userRoles` relation written
 * as `{ create: [...] }` comes back as that write object, not the loaded rows).
 * Script such rows explicitly with `prisma.on('user.create', row)` whenever the
 * code under test reads relations out of the result.
 */

export interface PrismaCall {
  /** Dotted call key, e.g. `user.findUnique`. Client-level calls are `$queryRaw`. */
  key: string;
  /** The arguments Prisma was called with (read-only for assertions). */
  args: unknown;
}

export type PrismaResponder = (args: any) => unknown;

/** Models the application touches. Unknown names still work — this is only for
 *  nicer `in` checks and documentation. */
const KNOWN_MODELS = [
  'user',
  'userRole',
  'role',
  'refreshToken',
  'event',
  'eventType',
  'committee',
  'committeeMember',
  'eventTask',
  'eventSchedule',
  'document',
  'notification',
  'auditLog',
] as const;

const DELEGATE_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

type ScriptedValue = unknown;

export class FakePrisma {
  /** Every call made against the fake, in order. */
  readonly calls: PrismaCall[] = [];

  private readonly scripts = new Map<string, ScriptedValue[]>();
  private readonly delegates = new Map<string, Record<string, unknown>>();

  /** Script the reply for a call key. Multiple values are consumed in order;
   *  the last value repeats for any further calls. */
  on(key: string, ...values: ScriptedValue[]): this {
    this.scripts.set(key, values);
    return this;
  }

  /** Calls recorded for a key, e.g. `prisma.callsFor('event.create')`. */
  callsFor(key: string): unknown[] {
    return this.calls.filter((call) => call.key === key).map((call) => call.args);
  }

  has(key: string): boolean {
    return this.calls.some((call) => call.key === key);
  }

  reset(): void {
    this.calls.length = 0;
    this.scripts.clear();
    this.delegates.clear();
  }

  /** Prisma client-level helpers. None of them touch a connection; each one
   *  honours scripts registered under its own key, e.g.
   *  `prisma.on('$queryRaw', () => { throw new Error('db down') })`. */
  async $queryRaw(...args: unknown[]): Promise<unknown[]> {
    this.calls.push({ key: '$queryRaw', args });
    return this.respond('$queryRaw', args, [{ ok: 1 }]) as unknown[];
  }

  async $executeRaw(...args: unknown[]): Promise<number> {
    this.calls.push({ key: '$executeRaw', args });
    return this.respond('$executeRaw', args, 0) as number;
  }

  async $queryRawUnsafe(...args: unknown[]): Promise<unknown[]> {
    this.calls.push({ key: '$queryRawUnsafe', args });
    return this.respond('$queryRawUnsafe', args, []) as unknown[];
  }

  async $executeRawUnsafe(...args: unknown[]): Promise<number> {
    this.calls.push({ key: '$executeRawUnsafe', args });
    return this.respond('$executeRawUnsafe', args, 0) as number;
  }

  /** Returns the scripted reply for `key`, consuming queued values in order and
   *  falling back to `fallback` when nothing is scripted. */
  respond(key: string, args: unknown, fallback: unknown): unknown {
    const script = this.scripts.get(key);
    if (!script || script.length === 0) {
      return fallback;
    }
    const value = script.length === 1 ? script[0] : (script.shift() as ScriptedValue);
    return typeof value === 'function' ? (value as PrismaResponder)(args) : value;
  }

  async $connect(): Promise<void> {
    this.calls.push({ key: '$connect', args: [] });
  }

  async $disconnect(): Promise<void> {
    this.calls.push({ key: '$disconnect', args: [] });
  }

  $on(): void {
    /* event subscriptions are a no-op in tests */
  }

  /** Supports both `.$transaction([...])` and `.$transaction(async (tx) => ...)`. */
  async $transaction(arg: unknown): Promise<unknown> {
    this.calls.push({ key: '$transaction', args: arg });
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)(this);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return undefined;
  }

  /** Builds (and caches) a model delegate such as `prisma.event`. */
  delegate(model: string): Record<string, unknown> {
    const cached = this.delegates.get(model);
    if (cached) {
      return cached;
    }

    const record = (method: string) => (args?: unknown) => {
      const key = `${model}.${method}`;
      this.calls.push({ key, args });
      return this.respond(key, args, defaultResult(method, args));
    };

    const delegate: Record<string, unknown> = {};
    for (const method of DELEGATE_METHODS) {
      delegate[method] = record(method);
    }
    this.delegates.set(model, delegate);
    return delegate;
  }
}

function defaultResult(method: string, args: unknown): unknown {
  const data = (args as { data?: unknown; where?: unknown } | undefined)?.data;
  const where = (args as { where?: unknown } | undefined)?.where;

  switch (method) {
    case 'findMany':
    case 'groupBy':
      return [];
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'findFirst':
    case 'findFirstOrThrow':
      return null;
    case 'count':
      return 0;
    case 'aggregate':
      return { _count: 0 };
    case 'createMany':
    case 'updateMany':
    case 'deleteMany':
      return { count: 0 };
    case 'delete':
      return where ?? {};
    case 'create':
    case 'update':
    case 'upsert':
      return { ...(where as object), ...(data as object) };
    default:
      return null;
  }
}

/**
 * Returns a `PrismaService`-shaped object. Unknown property access yields a
 * model delegate, so `fake.anythingYouLike.findMany()` works without setup.
 */
export function createFakePrisma(): FakePrisma {
  const core = new FakePrisma();
  return new Proxy(core, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return target.delegate(prop);
    },
  }) as FakePrisma;
}

export const FAKE_PRISMA_MODELS: readonly string[] = KNOWN_MODELS;
