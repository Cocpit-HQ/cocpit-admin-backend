const { pool } = require('../../config/db');
const { logAdminActivity } = require('../../utils/auditLogger');

// Basic UUID check
const isUUID = (str) => {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return regex.test(str);
};

exports.globalSearch = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters long' });
    }

    let searchQuery = q.trim();
    if (searchQuery.startsWith('#')) {
      searchQuery = searchQuery.slice(1);
    }

    let users = [];
    let organizations = [];
    let jobs = [];

    if (isUUID(searchQuery)) {
      // Search by exact UUID
      const userResult = await req.db.query(
        'SELECT user_id, full_name, email, avatar_url, job_title FROM users WHERE user_id = $1',
        [searchQuery]
      );
      users = userResult.rows;

      const orgResult = await req.db.query(
        'SELECT org_id, name, slug, logo_url, industry, verification_status FROM organizations WHERE org_id = $1',
        [searchQuery]
      );
      organizations = orgResult.rows;

      const jobResult = await req.db.query(
        'SELECT job_id, title, company_name, location, status FROM jobs WHERE job_id = $1',
        [searchQuery]
      );
      jobs = jobResult.rows;
    } else {
      // Search by text (ILIKE)
      const ilikeQuery = `%${searchQuery}%`;
      
      const userResult = await req.db.query(
        `SELECT user_id, full_name, email, avatar_url, job_title 
         FROM users 
         WHERE full_name ILIKE $1 OR email ILIKE $1 OR user_id::text ILIKE $1
         ORDER BY full_name ASC 
         LIMIT 10`,
        [ilikeQuery]
      );
      users = userResult.rows;

      const orgResult = await req.db.query(
        `SELECT org_id, name, slug, logo_url, industry, verification_status 
         FROM organizations 
         WHERE name ILIKE $1 OR slug ILIKE $1 OR org_id::text ILIKE $1
         ORDER BY name ASC 
         LIMIT 10`,
        [ilikeQuery]
      );
      organizations = orgResult.rows;

      const jobResult = await req.db.query(
        `SELECT job_id, title, company_name, location, status 
         FROM jobs 
         WHERE title ILIKE $1 OR company_name ILIKE $1 OR job_id::text ILIKE $1
         ORDER BY created_at DESC 
         LIMIT 10`,
        [ilikeQuery]
      );
      jobs = jobResult.rows;
    }

    res.json({
      users,
      organizations,
      jobs
    });
  } catch (err) {
    console.error('[Admin] Global Search Error:', err);
    res.status(500).json({ error: 'Internal server error during search' });
  }
};
