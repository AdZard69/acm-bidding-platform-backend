// In-memory persistence boundary for route/service tests. Real PostgreSQL tests
// additionally verify connector behavior, SQL constraints and migrations.
const { isDeepStrictEqual } = require('node:util');
const createMemoryPrisma = ({ slotsPerPrompt = 3 } = {}) => {
  const tables = { config: [], admins: [], teams: [], prompts: [], bids: [], assignments: [], scores: [], logs: [], submissions: [] };
  const ids = Object.fromEntries(Object.keys(tables).map((name) => [name, 0]));
  const clone = (value) => structuredClone(value);
  const error = (code, message, meta) => Object.assign(new Error(message), { code, meta });
  const byId = (name, id) => tables[name].find((row) => row.id === id);
  const related = (name, row, key) => {
    if (key === 'team') return ['teams', byId('teams', row.teamId) || null];
    if (key === 'prompt') return ['prompts', byId('prompts', row.promptId) || null];
    if (key === 'assignment') return ['assignments', tables.assignments.find((a) => a.teamId === row.id) || null];
    if (key === 'score') return ['scores', tables.scores.find((a) => a.teamId === row.id) || null];
    if (key === 'submission') return ['submissions', tables.submissions.find((s) => s.teamId === row.id) || null];
    if (key === 'assignments') return ['assignments', tables.assignments.filter((a) => a.promptId === row.id)];
    if (key === 'bids') return ['bids', tables.bids.filter((a) => a.teamId === row.id)];
    return null;
  };
  const matches = (name, row, where = {}) => row != null && Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some((condition) => matches(name, row, condition));
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((condition) => matches(name, row, condition));
    if (key === 'NOT') return !matches(name, row, value);
    if (key === 'teamId_promptId_round') return matches(name, row, value);
    const relation = related(name, row, key);
    if (relation) {
      const [table, relatedRow] = relation;
      if (value === null) return relatedRow === null;
      if (value?.is === null) return relatedRow === null;
      return matches(table, relatedRow, value?.is || value);
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('equals' in value) return isDeepStrictEqual(row[key], value.equals);
      if ('not' in value) return row[key] !== value.not;
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('gte' in value) return row[key] >= value.gte;
      if ('lt' in value) return row[key] < value.lt;
    }
    return row[key] === value;
  });
  const decorate = (name, row, { include = {}, select } = {}) => {
    const result = select ? {} : clone(row);
    for (const [key, options] of Object.entries(select || include)) {
      if (!options) continue;
      const relation = related(name, row, key);
      if (!relation) { if (select) result[key] = clone(row[key]); continue; }
      const [table, relatedRows] = relation;
      const config = options === true ? {} : options;
      result[key] = Array.isArray(relatedRows)
        ? relatedRows.filter((value) => matches(table, value, config.where)).map((value) => decorate(table, value, config))
        : relatedRows ? decorate(table, relatedRows, config) : null;
    }
    return result;
  };
  const unique = {
    config: [['id']], admins: [['id'], ['username']], teams: [['id'], ['teamName']], prompts: [['id']],
    bids: [['id'], ['teamId', 'promptId', 'round'], ['promptId', 'bidMinutes', 'round']],
    assignments: [['id'], ['teamId']], scores: [['id'], ['teamId']], logs: [['id']],
    submissions: [['id'], ['teamId']]
  };
  const validate = (name, row, excludeId) => {
    for (const fields of unique[name]) {
      if (tables[name].some((other) => other.id !== excludeId && fields.every((field) => other[field] === row[field])))
        throw error('P2002', 'Unique constraint failed', { target: fields });
    }
    for (const [key, table] of [['teamId', 'teams'], ['promptId', 'prompts'], ['adminId', 'admins']]) {
      if (row[key] != null && !byId(table, row[key])) throw error('P2003', 'Foreign key constraint failed');
    }
  };
  const ensureDeletable = (name, rows) => {
    const key = name === 'teams' ? 'teamId' : name === 'prompts' ? 'promptId' : null;
    if (key && ['bids', 'assignments', 'scores', 'submissions'].some((table) =>
      tables[table].some((row) => rows.some((parent) => row[key] === parent.id))))
      throw error('P2003', 'Foreign key constraint failed');
  };
  let database;
  const query = (name, action, args, run) => {
    let pending;
    const execute = () => pending ||= Promise.resolve().then(async () => {
      await database.onQuery?.({ model: name, action, args });
      return run();
    });
    return { then: (resolve, reject) => execute().then(resolve, reject), catch: (reject) => execute().catch(reject) };
  };
  const model = (name, defaults = {}) => {
    const findRows = ({ where, orderBy, take } = {}) => {
      const rows = tables[name].filter((row) => matches(name, row, where));
      const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      rows.sort((a, b) => {
        for (const entry of order) {
          const [key, direction] = Object.entries(entry)[0];
          if (a[key] < b[key]) return direction === 'asc' ? -1 : 1;
          if (a[key] > b[key]) return direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
      return take == null ? rows : rows.slice(0, take);
    };
    const create = (args) => {
      const row = { id: args.data.id ?? ++ids[name], createdAt: new Date(), ...clone(defaults), ...clone(args.data) };
      validate(name, row);
      tables[name].push(row);
      return decorate(name, row, args);
    };
    const update = (args) => {
      const row = findRows(args)[0];
      if (!row) throw error('P2025', 'Record not found');
      const updated = { ...row, ...clone(args.data) };
      validate(name, updated, row.id);
      Object.assign(row, updated);
      return decorate(name, row, args);
    };
    return {
      findMany: (args = {}) => query(name, 'findMany', args, () => findRows(args).map((row) => decorate(name, row, args))),
      findFirst: (args = {}) => query(name, 'findFirst', args, () => { const row = findRows(args)[0]; return row ? decorate(name, row, args) : null; }),
      findUnique: (args) => query(name, 'findUnique', args, () => { const row = findRows(args)[0]; return row ? decorate(name, row, args) : null; }),
      count: (args = {}) => query(name, 'count', args, () => findRows(args).length),
      aggregate: (args = {}) => query(name, 'aggregate', args, () => ({ _max: Object.fromEntries(Object.keys(args._max || {}).map((key) => [key, findRows(args).length ? Math.max(...findRows(args).map((row) => row[key])) : null])) })),
      create: (args) => query(name, 'create', args, () => create(args)),
      update: (args) => query(name, 'update', args, () => update(args)),
      updateMany: (args) => query(name, 'updateMany', args, () => { const rows = findRows(args); rows.forEach((row) => update({ where: { id: row.id }, data: args.data })); return { count: rows.length }; }),
      delete: (args) => query(name, 'delete', args, () => {
        const row = findRows(args)[0];
        if (!row) throw error('P2025', 'Record not found');
        ensureDeletable(name, [row]);
        tables[name] = tables[name].filter((value) => value !== row);
        return clone(row);
      }),
      deleteMany: (args = {}) => query(name, 'deleteMany', args, () => {
        const rows = findRows(args);
        ensureDeletable(name, rows);
        tables[name] = tables[name].filter((row) => !rows.includes(row));
        return { count: rows.length };
      }),
      upsert: (args) => query(name, 'upsert', args, () => findRows(args).length
        ? update({ where: args.where, data: args.update, include: args.include, select: args.select })
        : create({ data: args.create, include: args.include, select: args.select }))
    };
  };
  database = {
    tables, onQuery: null,
    reset() {
      for (const name of Object.keys(tables)) { tables[name] = []; ids[name] = 0; }
      database.onQuery = null;
    },
    gameConfig: model('config', { baseTime: 120, minBid: 30, maxTeams: 10, slotsPerPrompt,
      bidDurationSeconds: 60, currentRound: 0, currentPromptIndex: -1, status: 'waiting', biddingState: null }),
    admin: model('admins', { role: 'admin' }), team: model('teams', { isActive: true }), prompt: model('prompts'),
    bid: model('bids', { round: 1 }), assignment: model('assignments'), score: model('scores'), adminLog: model('logs'),
    submission: model('submissions'),
    $connect: () => query('database', 'connect', {}, () => undefined),
    $disconnect: () => Promise.resolve(),
    $queryRaw: (...args) => query('database', 'queryRaw', args, () => [{ ready: 1 }]),
    $executeRawUnsafe: (...args) => query('database', 'executeRawUnsafe', args, () => 1),
    async $transaction(operations) {
      const saved = clone(tables);
      try {
        if (typeof operations === 'function') return await operations(database);
        const result = [];
        for (const operation of operations) result.push(await operation);
        return result;
      } catch (failure) {
        Object.assign(tables, saved);
        throw failure;
      }
    }
  };
  return database;
};
module.exports = { createMemoryPrisma };
