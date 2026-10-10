const { getPool } = require('../config/db');

/**
 * Middleware to dynamically assign the database pool based on the x-environment header.
 * Defaults to 'uat' (or process.env.DEFAULT_ENV) if the header is missing.
 */
const environmentMiddleware = (req, res, next) => {
  const envHeader = req.headers['x-environment'];
  const environment = envHeader ? envHeader.toLowerCase() : (process.env.DEFAULT_ENV || 'uat');

  try {
    req.db = getPool(environment);
    req.currentEnvironment = environment;
    next();
  } catch (error) {
    console.error(`Failed to get database pool for environment: ${environment}`, error.message);
    res.status(500).json({ error: 'Database connection error for the specified environment.' });
  }
};

module.exports = environmentMiddleware;
