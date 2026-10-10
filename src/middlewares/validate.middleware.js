const { z } = require('zod');

const validate = (schema) => async (req, res, next) => {
  try {
    await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });
    return next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formattedErrors = error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message
      }));
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed', 
        errors: formattedErrors 
      });
    }
    return res.status(400).json({ success: false, message: 'Invalid payload' });
  }
};

module.exports = { validate };
