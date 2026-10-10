/**
 * Global Express error handling middleware.
 * Ensures stack traces are not leaked in production and formats all errors standardly.
 */
module.exports = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  console.error(`[Admin Error Handler] ${err.stack || err.message}`);

  res.status(statusCode).json({
    success: false,
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred on the admin server.',
    ...(isProd ? {} : { stack: err.stack })
  });
};
