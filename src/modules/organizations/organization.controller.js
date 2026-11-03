const { pool } = require('../../config/db');
const redis = require('../../config/redis');
const socketService = require('../../services/socketBridge');

exports.getOrganizations = async (req, res) => {
  try {
    const { search = '', status = 'All', industry = 'All', page = 1, limit = 8 } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT org_id as id, name, legal_name, incorporation_date, verification_status, logo_url, slug, email, website, industry, location, is_suspended, created_at FROM organizations WHERE is_deleted = false';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR website ILIKE $${params.length} OR legal_name ILIKE $${params.length})`;
    }

    if (status !== 'All') {
      params.push(status === 'Suspended');
      query += ` AND is_suspended = $${params.length}`;
    }

    if (industry !== 'All') {
      params.push(industry);
      query += ` AND industry = $${params.length}`;
    }

    const countQuery = `SELECT COUNT(*) FROM (${query}) AS filtered_orgs`;
    const countRes = await req.db.query(countQuery, params);
    const totalCount = parseInt(countRes.rows[0].count, 10);

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const orgsRes = await req.db.query(query, params);
    const organizations = orgsRes.rows.map(org => ({
      id: org.id,
      name: org.name || 'Unnamed Org',
      legal_name: org.legal_name || org.name || '',
      incorporation_date: org.incorporation_date ? new Date(org.incorporation_date).toISOString().split('T')[0] : null,
      verification_status: org.verification_status || 'UNVERIFIED',
      logo_url: org.logo_url || null,
      slug: org.slug,
      email: org.email,
      website: org.website || 'N/A',
      industry: org.industry || 'Other',
      location: org.location || 'N/A',
      status: org.is_suspended ? 'Suspended' : 'Active',
      founded: org.created_at,
      initials: org.name ? org.name.substring(0, 2).toUpperCase() : 'NA'
    }));

    res.json({
      organizations,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page, 10)
    });

  } catch (error) {
    console.error('Error fetching organizations:', error);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
};

exports.getOrganizationDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch organization core details
    const orgQuery = `
      SELECT org_id as id, name, legal_name, incorporation_date, slug, email, website, industry, location, description, 
             verification_status, review_notes, moderation_flags, is_suspended, created_at,
             parent_org_id, size, slogan, logo_url, cover_url
      FROM organizations 
      WHERE org_id = $1 AND is_deleted = false
    `;

    // Fetch documents
    const docsQuery = `
      SELECT document_id as id, document_url, document_name, document_type, uploaded_at
      FROM organization_documents
      WHERE org_id = $1
      ORDER BY uploaded_at DESC
    `;
    
    // Fetch members
    const membersQuery = `
      SELECT om.user_id as id, u.full_name as name, u.email, om.status,
             COALESCE(oroles.name, om.role) as role, oroles.color
      FROM organization_members om
      JOIN users u ON om.user_id = u.user_id
      LEFT JOIN organization_roles oroles ON om.role_id = oroles.role_id
      WHERE om.org_id = $1
    `;
    
    // Fetch tech stack
    const techQuery = `
      SELECT stack_id as id, name, category, created_at
      FROM organization_tech_stack
      WHERE org_id = $1
    `;
    
    const activityQuery = `
      SELECT log_id as id, action as type, metadata,
             audit_logs.created_at as time, actor_id, u.full_name as author_name
      FROM audit_logs
      LEFT JOIN users u ON actor_id = u.user_id
      WHERE entity_type = 'ORGANIZATION' AND entity_id = $1
      ORDER BY audit_logs.created_at DESC
      LIMIT 20
    `;

    const [orgRes, docsRes, membersRes, techRes, activityRes] = await Promise.all([
      req.db.query(orgQuery, [id]),
      req.db.query(docsQuery, [id]),
      req.db.query(membersQuery, [id]),
      req.db.query(techQuery, [id]),
      req.db.query(activityQuery, [id])
    ]);
    
    if (orgRes.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    const org = orgRes.rows[0];
    
    // Format response to match frontend expectations
    const orgProfile = {
      org_id: org.id,
      name: org.name || 'Unnamed Org',
      legal_name: org.legal_name || org.name || '',
      incorporation_date: org.incorporation_date ? new Date(org.incorporation_date).toISOString().split('T')[0] : null,
      verification_status: org.verification_status || 'UNVERIFIED',
      logo_url: org.logo_url || null,
      slug: org.slug,
      email: org.email,
      website: org.website || 'N/A',
      industry: org.industry || 'Other',
      location: org.location || 'N/A',
      description: org.description || 'No description provided.',
      slogan: org.slogan || '',
      size: org.size || 'Unknown',
      established_year: 2020, // Default since it's not in DB
      followers_count: 0, // Default since it's not in DB
      moderation_flags: parseInt(org.moderation_flags || 0, 10),
      status: org.is_suspended ? 'Suspended' : 'Active',
      verification_status: org.verification_status || 'UNVERIFIED',
      review_notes: org.review_notes || '',
      logo_url: org.logo_url || (org.name ? org.name.substring(0, 2).toUpperCase() : 'NA'),
      cover_url: org.cover_url || 'https://via.placeholder.com/1200x300',
      documents: docsRes.rows,
      members: membersRes.rows,
      techStack: techRes.rows,
      activity: activityRes.rows
    };
    
    res.json(orgProfile);
  } catch (error) {
    console.error('Error fetching organization details:', error);
    res.status(500).json({ error: 'Failed to fetch organization details' });
  }
};

exports.warnOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, message, isSevere } = req.body;
    
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Warning reason is required.' });
    }
    
    let points = 0;
    if (isSevere) {
      points = 1;
    }
    
    // Insert into organization_warnings
    await req.db.query(
      'INSERT INTO organization_warnings (org_id, reason, message, is_severe) VALUES ($1, $2, $3, $4)',
      [id, reason, message, isSevere]
    );

    // Increment moderation flags
    const updateQuery = `
      UPDATE organizations 
      SET moderation_flags = COALESCE(moderation_flags, 0) + $2 
      WHERE org_id = $1 
      RETURNING moderation_flags, name, created_by
    `;
    const result = await req.db.query(updateQuery, [id, points]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    const newFlagsCount = parseInt(result.rows[0].moderation_flags);
    const targetName = result.rows[0].name || 'organization';
    const orgCreatorId = result.rows[0].created_by;
    const adminId = req.user.userId;
    let autoSuspended = false;
    
    if (newFlagsCount >= 7) {
      // Suspend and reset flags to 0
      await req.db.query(
        'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1',
        [id]
      );
      autoSuspended = true;
      // Log suspension
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
      );
    }
    
    // Notify the organization owner
    if (orgCreatorId) {
      const notificationText = isSevere 
        ? `Your organization "${targetName}" has received a severe warning. Reason: ${reason}. Message: ${message || 'No additional details'}`
        : `Your organization "${targetName}" has received a warning. Reason: ${reason}. Message: ${message || 'No additional details'}`;
      
      await req.db.query(`
        INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [orgCreatorId, adminId, 'organization_warning', notificationText, id, JSON.stringify({ orgId: id, reason, message, isSevere, autoSuspended })]);
      
      // Notify the organization (so it shows up when acting as the company)
      await req.db.query(`
        INSERT INTO notifications (recipient_org_id, sender_id, type, text, reference_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, adminId, 'organization_warning', notificationText, id, JSON.stringify({ orgId: id, reason, message, isSevere, autoSuspended })]);
      
      socketService.notifyUser(orgCreatorId, "notification", {
        user_id: orgCreatorId,
        type: 'organization_warning',
        text: notificationText,
        reference_id: id,
        created_at: new Date()
      });
    }

    // Log the warning action to audit logs
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_WARNING_SENT', `Sent a ${isSevere ? 'severe ' : ''}warning to ${targetName}. Reason: ${reason}`]
    );

    res.json({ message: 'Warning sent successfully', autoSuspended });
  } catch (error) {
    console.error('Error warning organization:', error);
    res.status(500).json({ error: 'Failed to warn organization' });
  }
};

exports.suspendOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;
    
    await req.db.query(
      'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1',
      [id]
    );
    
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_SUSPENDED', `Manually suspended organization with ID: ${id}`]
    );
    
    res.json({ message: 'Organization suspended successfully.' });
  } catch (error) {
    console.error('Error suspending organization:', error);
    res.status(500).json({ error: 'Failed to suspend organization' });
  }
};

exports.unsuspendOrganization = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;
    
    await req.db.query(
      'UPDATE organizations SET is_suspended = false, moderation_flags = 0 WHERE org_id = $1',
      [id]
    );
    
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'ORG_UNSUSPENDED', `Unsuspended organization with ID: ${id}`]
    );
    
    res.json({ message: 'Organization unsuspended successfully.' });
  } catch (error) {
    console.error('Error unsuspending organization:', error);
    res.status(500).json({ error: 'Failed to unsuspend organization' });
  }
};

exports.getOrganizationIndustries = async (req, res) => {
  try {
    const query = "SELECT DISTINCT industry FROM organizations WHERE is_deleted = false AND industry IS NOT NULL AND industry != '' ORDER BY industry ASC";
    const result = await req.db.query(query);
    const industries = result.rows.map(row => row.industry);
    res.json(industries);
  } catch (error) {
    console.error('Error fetching industries:', error);
    res.status(500).json({ error: 'Failed to fetch industries' });
  }
};

exports.getVerificationQueue = async (req, res) => {
  try {
    const query = `
      SELECT o.org_id as id, o.name as title, o.legal_name, o.incorporation_date, o.logo_url, o.verification_status, o.created_at,
             o.location, o.industry as type, o.size as salary, o.entity_type as mode, o.description,
             o.review_notes, u.full_name as author, ov.verification_id
      FROM organizations o
      LEFT JOIN users u ON o.created_by = u.user_id
      LEFT JOIN organization_verifications ov ON o.org_id = ov.org_id AND ov.is_verified = false
      WHERE o.is_deleted = false AND o.verification_status != 'UNVERIFIED'
      ORDER BY o.created_at DESC
    `;
    const result = await req.db.query(query);
    const orgs = result.rows;
    
    for (let org of orgs) {
      if (org.verification_status === 'DOCUMENT_PENDING' || org.verification_status === 'UNDER_REVIEW') {
        org.status = 'Under Review';
        org.statusBadgeColor = 'bg-indigo-600';
      } else if (org.verification_status === 'DOMAIN_PENDING') {
        org.status = 'Pending';
        org.statusBadgeColor = 'bg-surface-variant text-on-surface-variant';
      } else if (org.verification_status === 'VERIFIED' || org.verification_status === 'DOMAIN_VERIFIED') {
        org.status = 'Approved';
        org.statusBadgeColor = 'bg-green-600';
      } else if (org.verification_status === 'REJECTED') {
        org.status = 'Rejected';
        org.statusBadgeColor = 'bg-red-600';
        // Change company name for rejected organizations
        if (org.title && org.title.toLowerCase().includes('cocpit')) {
          org.title = org.title.replace(/cocpit/gi, 'Acme Corp');
        }
      } else {
        org.status = org.verification_status;
        org.statusBadgeColor = 'bg-slate-600';
      }
      
      org.date = org.created_at ? new Date(org.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      org.legal_name = org.legal_name || org.title || '';
      org.incorporation_date = org.incorporation_date ? new Date(org.incorporation_date).toISOString().split('T')[0] : '';
      org.fullLocation = org.location || 'N/A';
      org.author = org.author || 'N/A';
      
      const docsResult = await req.db.query(
        `SELECT document_id as id, document_name, document_type, document_url, uploaded_at, status, review_notes
         FROM organization_documents
         WHERE org_id = $1`,
        [org.id]
      );
      org.documents = docsResult.rows;
    }
    
    res.json(orgs);
  } catch (err) {
    console.error('Error in getVerificationQueue:', err);
    res.status(500).json({ error: 'Failed to fetch verification queue' });
  }
};

exports.reviewDocument = async (req, res) => {
  try {
    const { documentId } = req.params;
    const { status, notes } = req.body;
    const adminId = req.user.userId;
    
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const query = `
      UPDATE organization_documents
      SET status = $1, review_notes = $2
      WHERE document_id = $3
      RETURNING org_id, document_name
    `;
    const result = await req.db.query(query, [status, notes, documentId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    const { org_id, document_name } = result.rows[0];
    
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'DOCUMENT_REVIEWED', `Reviewed document "${document_name}" for Org ID: ${org_id}. Status: ${status}`]
    );
    
    res.json({ message: 'Document reviewed successfully', status });
  } catch (err) {
    console.error('Error in reviewDocument:', err);
    res.status(500).json({ error: 'Failed to review document' });
  }
};

exports.reviewOrganizationVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, rejectionReason } = req.body;
    const adminId = req.user.userId;
    
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }
    
    const { createAuditLog } = require('../../middlewares/auditLog.middleware');
    const client = await req.db.connect();
    try {
      await client.query('BEGIN');
      
      // Ensure admin exists in users table to prevent foreign key violations
      if (adminId) {
        await client.query(`
          INSERT INTO users (user_id, full_name, email, auth_provider, password_hash)
          VALUES ($1, 'Admin', 'admin@cocpit.ai', 'admin', 'N/A')
          ON CONFLICT (user_id) DO NOTHING
        `, [adminId]);
      }
      
      const fullNotes = rejectionReason ? `[Reason: ${rejectionReason}] ${notes || ''}` : notes;
      
      const updateOrgQuery = `
        UPDATE organizations
        SET verification_status = $1, review_notes = $2, reviewed_by = $3, reviewed_at = NOW(), verified_at = $5
        WHERE org_id = $4
        RETURNING name, created_by
      `;
      const verifiedAt = status === 'VERIFIED' ? new Date() : null;
      const orgRes = await client.query(updateOrgQuery, [status, fullNotes, adminId, id, verifiedAt]);
      if (orgRes.rows.length === 0) {
        throw new Error('Organization not found');
      }
      const orgName = orgRes.rows[0].name;
      const orgCreatorId = orgRes.rows[0].created_by;
      
      await client.query(
        `UPDATE organization_verifications
         SET is_verified = $1, reviewed_by = $2, review_notes = $3
         WHERE org_id = $4 AND is_verified = false`,
        [status === 'VERIFIED', adminId, fullNotes, id]
      );
      
      if (status === 'REJECTED') {
        // Automatically pause any active jobs posted by this organization
        await client.query(
          `UPDATE jobs SET status = 'PAUSED', is_active = false WHERE org_id = $1 AND status = 'ACTIVE'`,
          [id]
        );
      }
      
      await client.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, `ORG_VERIFICATION_${status}`, `Final review for organization "${orgName}": ${status}. Notes: ${fullNotes}`]
      );
      // Log the verification action
      await createAuditLog(adminId, `ORG_VERIFICATION_${status}`, `Final review for organization "${orgName}": ${status}. Notes: ${fullNotes}`);
      
      // Notify the organization creator
      if (orgCreatorId) {
        const notificationText = status === 'VERIFIED' 
          ? `Your organization "${orgName}" has been verified.`
          : `Your organization "${orgName}" verification was rejected. Reason: ${rejectionReason || 'See notes'}`;
          
        // Notify the user
        await client.query(`
          INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [orgCreatorId, adminId, 'organization_verification', notificationText, id, JSON.stringify({ orgId: id, status, rejectionReason })]);
        
        // Notify the organization (so it shows up when acting as the company)
        await client.query(`
          INSERT INTO notifications (recipient_org_id, sender_id, type, text, reference_id, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, adminId, 'organization_verification', notificationText, id, JSON.stringify({ orgId: id, status, rejectionReason })]);
        
        socketService.notifyUser(orgCreatorId, "notification", {
          user_id: orgCreatorId,
          type: 'organization_verification',
          text: notificationText,
          reference_id: id,
          created_at: new Date()
        });
      }
      
      await client.query('COMMIT');
      
      // Notify Main API
      await redis.publish('admin:organizations', JSON.stringify({ action: 'verification_updated', orgId: id, status }));
      
      res.json({ message: `Organization verification ${status.toLowerCase()} successfully` });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(400).json({ error: e.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in reviewOrganizationVerification:', err);
    res.status(500).json({ error: 'Failed to complete organization verification review', details: err.message });
  }
};

exports.bulkWarnOrganizations = async (req, res) => {
  try {
    const { orgIds, reason, message, isSevere } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET moderation_flags = COALESCE(moderation_flags, 0) + $1 WHERE org_id = $2 RETURNING name, created_by, moderation_flags',
        [isSevere ? 1 : 0, id]
      );
      if (updateResult.rows.length === 0) continue;

      const { name: targetName, created_by: orgCreatorId, moderation_flags: newFlagsCount } = updateResult.rows[0];
      let autoSuspended = false;

      if (newFlagsCount >= 7) {
        await req.db.query('UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1', [id]);
        autoSuspended = true;
        await req.db.query('INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)', [adminId, 'ORG_SUSPENDED', `Automatically suspended ${targetName} due to flags.`]);
      }

      await req.db.query('INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)', [adminId, 'ORG_WARNING_SENT', `Sent warning to ${targetName}. Reason: ${reason} (Bulk)`]);
      results.push({ id, name: targetName, moderation_flags: newFlagsCount, autoSuspended });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error warning organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to warn organizations in bulk' });
  }
};

exports.bulkSuspendOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_SUSPENDED', `Manually suspended ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Suspended' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error suspending organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to suspend organizations in bulk' });
  }
};

exports.bulkDeleteOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_deleted = true WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_DELETED', `Soft deleted ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Deleted' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error deleting organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to delete organizations in bulk' });
  }
};

exports.bulkUnsuspendOrganizations = async (req, res) => {
  try {
    const { orgIds } = req.body;
    if (!Array.isArray(orgIds) || orgIds.length === 0) {
      return res.status(400).json({ error: 'No organization IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of orgIds) {
      const updateResult = await req.db.query(
        'UPDATE organizations SET is_suspended = false, moderation_flags = 0 WHERE org_id = $1 RETURNING name',
        [id]
      );
      if (updateResult.rows.length === 0) continue;

      const targetName = updateResult.rows[0].name;
      await req.db.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'ORG_UNSUSPENDED', `Manually unsuspended ${targetName} (Bulk)`]
      );
      results.push({ id, name: targetName, status: 'Active' });
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error unsuspending organizations in bulk:', error);
    res.status(500).json({ error: 'Failed to unsuspend organizations in bulk' });
  }
};


exports.submitOrganizationVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { legal_name, incorporation_date, document_url, document_name, document_type = 'CERTIFICATE_OF_INCORPORATION' } = req.body;
    const adminId = req.user?.userId;

    if (!legal_name || !legal_name.trim()) {
      return res.status(400).json({ error: 'Organization legal full name is required' });
    }
    if (!incorporation_date) {
      return res.status(400).json({ error: 'Incorporation date is required' });
    }

    const client = await req.db.connect();
    try {
      await client.query('BEGIN');

      // 1. Update organizations table
      const updateOrgQuery = `
        UPDATE organizations
        SET legal_name = $1,
            incorporation_date = $2,
            verification_status = 'UNDER_REVIEW',
            updated_at = NOW()
        WHERE org_id = $3 AND is_deleted = false
        RETURNING name, slug, logo_url, created_by
      `;
      const orgRes = await client.query(updateOrgQuery, [legal_name.trim(), incorporation_date, id]);
      if (orgRes.rows.length === 0) {
        throw new Error('Organization not found');
      }
      const org = orgRes.rows[0];

      // 2. Insert into organization_documents if document provided
      let docRecord = null;
      if (document_url) {
        const docName = document_name || `${legal_name.trim()}_Verification_Document`;
        const insertDocQuery = `
          INSERT INTO organization_documents (org_id, document_url, document_name, document_type, uploaded_at)
          VALUES ($1, $2, $3, $4, NOW())
          RETURNING document_id, document_url, document_name
        `;
        const docRes = await client.query(insertDocQuery, [id, document_url, docName, document_type]);
        docRecord = docRes.rows[0];
      }

      // 3. Insert or update organization_verifications tracking
      const insertVerifQuery = `
        INSERT INTO organization_verifications (
          org_id, user_id, verification_type, legal_name, incorporation_date, document_urls, document_type, is_verified, created_at
        ) VALUES (
          $1, $2, 'DOCUMENT', $3, $4, $5, $6, false, NOW()
        )
        RETURNING verification_id
      `;
      await client.query(insertVerifQuery, [
        id,
        org.created_by || adminId,
        legal_name.trim(),
        incorporation_date,
        document_url || null,
        document_type
      ]);

      // 4. Log audit action
      if (adminId) {
        await client.query(
          'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
          [adminId, 'ORG_VERIFICATION_SUBMITTED', `Submitted verification credentials for organization "${org.name}": Legal Name: ${legal_name}, Inc. Date: ${incorporation_date}`]
        );
      }

      await client.query('COMMIT');

      // Publish Redis event for real-time awareness
      try {
        await redis.publish('admin:organizations', JSON.stringify({
          action: 'verification_submitted',
          orgId: id,
          legal_name: legal_name.trim(),
          status: 'UNDER_REVIEW'
        }));
      } catch (rErr) {
        console.warn('Redis pub/sub notification skipped:', rErr.message);
      }

      res.json({
        message: 'Organization verification submitted successfully',
        org: {
          id,
          name: org.name,
          legal_name: legal_name.trim(),
          incorporation_date,
          verification_status: 'UNDER_REVIEW',
          document: docRecord
        }
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error submitting organization verification:', error);
    res.status(500).json({ error: error.message || 'Failed to submit organization verification' });
  }
};
