const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const getPoolConfig = (host, port, user, password, dbName) => {
  const hostVal = host || process.env.DB_HOST || '192.168.1.50';
  const isLocalHost = hostVal === 'localhost' || hostVal.startsWith('127.') || hostVal.startsWith('192.168.');
  const enableSsl = process.env.DB_SSL !== undefined 
    ? process.env.DB_SSL === 'true' 
    : (isProduction && !isLocalHost);

  return {
    host: hostVal,
    port: port ? Number(port) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432),
    user: user || process.env.DB_USER || 'sanika',
    password: password || process.env.DB_PASSWORD || 'cocpit@4713',
    database: dbName || process.env.DB_NAME || 'cocpit_backend_uat',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    query_timeout: 60000,
    ssl: enableSsl ? { rejectUnauthorized: false } : false,
  };
};

const pools = {};

function getPool(environment) {
  const env = environment ? environment.toLowerCase() : 'uat';

  if (pools[env]) return pools[env];

  let pool;
  if (process.env.DATABASE_URL && !process.env.DB_HOST) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 60000,
      query_timeout: 60000,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  } else {
    let dbName = process.env.DB_NAME || 'cocpit_backend_uat';
    if (env === 'production') {
      dbName = process.env.PROD_DB_NAME || process.env.DB_NAME;
    } else if (env === 'uat') {
      dbName = process.env.UAT_DB_NAME || process.env.DB_NAME;
    } else if (env === 'staging') {
      dbName = process.env.STAGING_DB_NAME || process.env.DB_NAME;
    }

    const config = getPoolConfig(
      process.env.DB_HOST,
      process.env.DB_PORT,
      process.env.DB_USER,
      process.env.DB_PASSWORD,
      dbName
    );

    pool = new Pool(config);
  }

  pool.on('error', (err) => {
    console.error(`🔥 Unexpected PostgreSQL error on idle client [${env}]`, err.message);
  });

  pools[env] = pool;
  return pool;
}

// Default pool
const defaultPool = getPool(process.env.DEFAULT_ENV || 'uat');

module.exports = {
  pool: defaultPool,
  getPool,
  query: (text, params) => defaultPool.query(text, params),
};
