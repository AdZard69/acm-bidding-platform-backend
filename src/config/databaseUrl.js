// Prisma 5's PostgreSQL driver enforces these limits, including the actual SQL
// request. Promise.race alone cannot cancel a database write safely.
const databaseUrl = (value, env) => {
  if (!value) return value;
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return value;
  const defaults = {
    connection_limit: env.DB_CONNECTION_LIMIT,
    connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
    pool_timeout: env.DB_POOL_TIMEOUT_SECONDS,
    socket_timeout: env.DB_QUERY_TIMEOUT_SECONDS
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, String(fallback));
  }
  return url.toString();
};
module.exports = { databaseUrl };
