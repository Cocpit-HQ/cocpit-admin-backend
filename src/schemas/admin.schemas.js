const { z } = require('zod');

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required')
  })
});

const updateFlagSchema = z.object({
  body: z.object({
    key: z.string().optional(),
    value: z.boolean().optional(),
    features: z.record(z.any()).optional(),
    flags: z.record(z.any()).optional()
  })
});

module.exports = {
  loginSchema,
  updateFlagSchema
};
